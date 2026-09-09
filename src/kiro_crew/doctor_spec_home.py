"""``kirocrew doctor``: detect agent specs whose managed MCP env pins a foreign data home.

Every managed Kiro Crew MCP server entry in an agent spec (``kirocrew-core``,
``kirocrew-cron``, ...) is launched by kiro-cli with the spec's ``env`` laid over
the inherited environment, and ``agent._managed_mcp_env`` pins ``KIROCREW_HOME``
there whenever the WRITER ran under a data-home override. A spec written by one
instance and read by another therefore makes the reader's shims resolve
``config_dir()`` to the writer's home: they look up their signed session-pid
mapping, the SEL trust root, the cron store and the lessons file somewhere the
running gateway never writes. Every strict-identity tool is then refused with
"signed pid mapping did not verify" while ``kirocrew doctor``'s trust-root check
-- run against the gateway's own home -- reports green.

This module answers the question that check cannot: *do the specs this gateway's
sessions will spawn from agree with this gateway about where the data home is?*
It walks every ``*.json`` in the agents dir and compares each ``mcpServers.*.env
.KIROCREW_HOME`` PIN against the data home THIS process resolves. A spec with no
pin is not a finding: a default-home writer emits none, so under the default
home that is the correct shape (see :func:`check_spec_home_drift`).

Report-only. The remedy for a managed spec is one command
(``kirocrew setup --agent-only``, run from the gateway's own home, rewrites the
managed specs from THIS install), and doctor names it rather than running it: a
rebuild is a write to the shared kiro-cli home and belongs to a verb the operator
invokes on purpose. A foreign spec (another tool's agent that happens to declare
a Kiro Crew server) is named for the operator to edit by hand; Kiro Crew never
rewrites what it does not own.

Same shape as :mod:`kiro_crew.doctor_deadpath`: one public check returning a
report, one thin renderer, and an ``agents_dir`` argument so doctor scans the
directory it is inspecting rather than re-resolving the live home.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from pathlib import Path

from kiro_crew.agent_discovery import _read_agent_spec
from kiro_crew.agent_files import OWNED_KIRO_AGENT_FILES
from kiro_crew.config.paths import data_home, kiro_agents_dir
from kiro_crew.doctor_deadpath import _sanitize_for_terminal

logger = logging.getLogger(__name__)

#: The env key the check is about. A module constant rather than a literal in
#: three places: the writer (``agent._managed_mcp_env``) and this reader must
#: agree on the spelling, and a test can assert against the same name.
PINNED_HOME_KEY = "KIROCREW_HOME"


@dataclass
class HomeDrift:
    """One managed-server entry whose pinned data home disagrees with ours."""

    spec: str  # spec filename (e.g. "kirocrew.json")
    server: str  # mcpServers entry name
    pinned: str  # the KIROCREW_HOME value the spec carries (never empty)
    managed: bool  # spec is one of OWNED_KIRO_AGENT_FILES (ours to rewrite)


@dataclass
class HomeDriftReport:
    """Everything the doctor renderer needs, split by who may fix it."""

    expected: str = ""  # the data home this process resolved
    scanned: int = 0  # spec files that parsed as JSON objects
    drift: list[HomeDrift] = field(default_factory=list)

    @property
    def managed(self) -> list[HomeDrift]:
        return [d for d in self.drift if d.managed]

    @property
    def foreign(self) -> list[HomeDrift]:
        return [d for d in self.drift if not d.managed]


def _canonical(path: str | Path) -> str:
    """One spelling for a home so ``~/x``, ``/x/`` and a symlink compare equal.

    ``resolve(strict=False)`` never raises for a missing path; the ``OSError``
    arm covers an unreadable ancestor, where the lexical form is the best we
    have and a false "drift" is still preferable to a crash in doctor.
    """
    try:
        return str(Path(str(path)).expanduser().resolve())
    except (OSError, RuntimeError):
        return str(path)


def _pinned_home(entry: dict) -> str | None:
    """The ``KIROCREW_HOME`` a server entry pins, ``""`` when it pins none.

    ``None`` when the entry has no usable ``env`` at all (not an object), so the
    caller can skip it rather than read a malformed spec as "default home".
    Matched case-insensitively on the key because kiro-cli's env is applied to a
    process environment, and ``env.sanitize_spec_env`` folds case the same way.
    """
    env = entry.get("env")
    if env is None:
        return ""
    if not isinstance(env, dict):
        return None
    for key, value in env.items():
        if isinstance(key, str) and key.upper() == PINNED_HOME_KEY:
            return value if isinstance(value, str) else None
    return ""


def check_spec_home_drift(*, agents_dir: Path | None = None) -> HomeDriftReport:
    """Compare every spec's pinned ``KIROCREW_HOME`` against this process's data home.

    Args:
        agents_dir: The agents directory to scan. Defaults to the live
            :func:`kiro_agents_dir`. ``kirocrew doctor`` passes its OWN resolved
            directory so the scan covers exactly what it is inspecting.

    The expected home is :func:`data_home` -- the override when this process
    runs under one, else the default. Only a spec that PINS a home, and pins a
    different one, is drift. A spec with no pin is left alone on purpose: a
    default-home writer emits none (``_managed_mcp_env`` returns ``{}`` there),
    so under the default home an unpinned spec is correct, and under an override
    it means at worst that the shims derive the default home -- a different,
    quieter defect than the one this check exists to name, and one that does not
    arise once a non-default instance owns its own agents dir. Flagging it would
    also turn every hand-written fixture spec into a finding.

    Fail-open per file: an unreadable or malformed spec is skipped (the dead-path
    check already reports those), never aborting the walk.
    """
    if agents_dir is None:
        agents_dir = kiro_agents_dir()
    report = HomeDriftReport(expected=_canonical(data_home()))
    if not agents_dir.is_dir():
        return report

    managed_names = set(OWNED_KIRO_AGENT_FILES)
    try:
        entries = sorted(
            (Path(e.path) for e in os.scandir(agents_dir) if e.name.endswith(".json")),
            key=lambda p: p.name,
        )
    except OSError as exc:  # pragma: no cover - defensive: dir vanished mid-scan
        logger.debug("agents dir %s unreadable: %s", agents_dir, exc)
        return report

    for spec_path in entries:
        # The one hardened reader every spec consumer uses: refuses a symlink
        # whose resolved target is sensitive, a non-UTF-8 or oversized file, and
        # anything that is not a JSON object -- all as ``None``, fail-open per
        # file. The agents dir is user-writable and shared with other tools, so
        # a bare ``read_text`` here would be the one spec read outside the gate.
        data = _read_agent_spec(spec_path, operation="doctor", source="cli")
        if data is None:
            continue
        report.scanned += 1
        servers = data.get("mcpServers")
        if not isinstance(servers, dict):
            continue
        for server, entry in servers.items():
            if not isinstance(entry, dict):
                continue
            pinned = _pinned_home(entry)
            if not pinned:
                continue
            if _canonical(pinned) == report.expected:
                continue
            report.drift.append(
                HomeDrift(
                    spec=spec_path.name,
                    server=str(server),
                    pinned=pinned,
                    managed=spec_path.name in managed_names,
                )
            )
    return report


def doctor_spec_home_drift(issues: list[str], *, agents_dir: Path | None = None) -> None:
    """Render the ``Agent Spec Data Home`` section of ``kirocrew doctor``.

    Silent-ish on a healthy install (one ✅ line). A managed spec whose pinned
    home disagrees with this process's is a real finding -- it is the exact state
    under which every strict-identity MCP tool is refused -- so it is appended to
    *issues* and doctor exits nonzero, with the one-command remedy on the line.

    Best-effort: a failure inside the walk must not abort the doctor run.
    """
    print("\nAgent Spec Data Home")
    try:
        report = check_spec_home_drift(agents_dir=agents_dir)
    except Exception as exc:  # noqa: BLE001 — doctor must survive a broken walk
        print(f"  pins:        ⚠️  could not check ({exc})")
        return

    if not report.scanned:
        print("  pins:        ⏹ no agent specs found")
        return

    if not report.drift:
        print(
            f"  pins:        ✅ every managed MCP server resolves this data home ({report.expected})"
        )
        return

    print(f"  expected:    {report.expected}")
    for d in report.managed:
        print(
            f"  {_sanitize_for_terminal(d.spec)}: ⚠️  {_sanitize_for_terminal(d.server)} pins "
            f"KIROCREW_HOME={_sanitize_for_terminal(d.pinned)}"
        )
    if report.managed:
        print(
            "               Sessions spawned from these specs verify their identity "
            "against THAT home, so every"
        )
        print(
            "               strict-identity tool (session_ledger_*, monitor_*, "
            "list_sessions, ...) is refused"
        )
        print(
            "               while this gateway's trust root looks healthy. Another "
            "instance rebuilt the shared"
        )
        print(
            "               specs from a different KIROCREW_HOME. Fix: "
            "`kirocrew setup --agent-only` from this home."
        )
        issues.append("agent specs pin a different KIROCREW_HOME than this data home")
    for d in report.foreign:
        print(
            f"  {_sanitize_for_terminal(d.spec)}: ⚠️  {_sanitize_for_terminal(d.server)} pins "
            f"KIROCREW_HOME={_sanitize_for_terminal(d.pinned)} "
            f"(foreign spec — not rewritten by setup; edit it by hand)"
        )
    if report.foreign:
        issues.append("foreign agent specs pin a different KIROCREW_HOME than this data home")
