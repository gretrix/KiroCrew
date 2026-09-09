"""A non-default ``KIROCREW_HOME`` must not rewrite the shared ``~/.kiro/agents`` specs.

The failure these pin: a throwaway gateway booted with ``KIROCREW_HOME=<scratch>``
(no ``KIRO_HOME``, not a worktree, not under the temp root) runs
``rebuild_agent_config`` on boot, rewrites the operator's machine-wide
``~/.kiro/agents/*.json`` and pins ``KIROCREW_HOME=<scratch>`` into every
managed MCP server's ``env``. Every ``kirocrew-core`` stub the REAL gateway's
sessions spawn afterwards resolves ``config_dir()`` to the scratch home, finds
no signed session-pid mapping there, and every strict-identity tool is refused
with "signed pid mapping did not verify" -- while ``kirocrew doctor`` on the real
gateway reports a healthy trust root.

Three layers are pinned here:

* ``config.paths.foreign_data_home`` / ``adopt_isolated_kiro_home`` -- a
  non-default data home is given its OWN kiro home (``<data home>/kiro``) via
  ``KIRO_HOME``, the same recipe pods and the E2E harness already use by hand;
* ``agent._decline_shared_agent_home`` -- and if a caller bypasses that prologue,
  the write guard refuses the shared target outright (audited);
* ``doctor_spec_home`` -- ``kirocrew doctor`` names a spec whose pin disagrees
  with the data home it runs on, with the one-command remedy.
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

import pytest

from conftest import requires_symlinks
from kiro_crew.config import paths
from kiro_crew.config.paths import (
    adopt_isolated_kiro_home,
    foreign_data_home,
    isolated_agents_dir,
    isolated_kiro_home,
)

REPO_ROOT = Path(__file__).resolve().parents[1]


def _relocate_main_homes(monkeypatch, tmp_path: Path) -> tuple[Path, Path]:
    """Point the default/legacy data homes at tmp so no test names the real ones."""
    default = tmp_path / "user" / ".kiro" / "crew"
    legacy = tmp_path / "user" / ".kirocrew"
    monkeypatch.setattr(paths, "_default_home", lambda: default)
    monkeypatch.setattr(paths, "_legacy_home", lambda: legacy)
    return default, legacy


# --------------------------------------------------------------------------
# foreign_data_home: which instance owns ~/.kiro
# --------------------------------------------------------------------------
class TestForeignDataHome:
    def test_no_override_is_the_main_instance(self, monkeypatch, tmp_path):
        _relocate_main_homes(monkeypatch, tmp_path)
        monkeypatch.delenv("KIROCREW_HOME", raising=False)
        assert foreign_data_home() is None

    def test_override_naming_the_default_home_is_still_main(self, monkeypatch, tmp_path):
        default, _ = _relocate_main_homes(monkeypatch, tmp_path)
        default.mkdir(parents=True)
        # A trailing slash and a symlink are both re-spellings of the same home.
        monkeypatch.setenv("KIROCREW_HOME", str(default) + "/")
        assert foreign_data_home() is None

    def test_override_naming_the_legacy_home_is_still_main(self, monkeypatch, tmp_path):
        _, legacy = _relocate_main_homes(monkeypatch, tmp_path)
        legacy.mkdir(parents=True)
        monkeypatch.setenv("KIROCREW_HOME", str(legacy))
        assert foreign_data_home() is None

    def test_any_other_valid_override_is_foreign(self, monkeypatch, tmp_path):
        _relocate_main_homes(monkeypatch, tmp_path)
        scratch = tmp_path / "scratch" / "runtime-3c0a7e8b" / "pfshot" / "home"
        scratch.mkdir(parents=True)
        monkeypatch.setenv("KIROCREW_HOME", str(scratch))
        assert foreign_data_home() == scratch.resolve()

    def test_an_unsafe_override_is_not_foreign(self, monkeypatch, tmp_path):
        """A refused override (``/``) falls back to the default home everywhere
        else, so it must read as the main instance here too -- otherwise the
        write guard would refuse the real install its own specs."""
        _relocate_main_homes(monkeypatch, tmp_path)
        monkeypatch.setenv("KIROCREW_HOME", "/")
        assert foreign_data_home() is None


# --------------------------------------------------------------------------
# adopt_isolated_kiro_home: the prologue export
# --------------------------------------------------------------------------
class TestAdoptIsolatedKiroHome:
    def test_default_home_exports_nothing(self, monkeypatch, tmp_path):
        _relocate_main_homes(monkeypatch, tmp_path)
        monkeypatch.delenv("KIROCREW_HOME", raising=False)
        monkeypatch.delenv("KIRO_HOME", raising=False)
        assert adopt_isolated_kiro_home() is None
        assert "KIRO_HOME" not in os.environ

    def test_foreign_home_adopts_its_own_kiro_home(self, monkeypatch, tmp_path):
        _relocate_main_homes(monkeypatch, tmp_path)
        scratch = tmp_path / "scratch-home"
        scratch.mkdir()
        monkeypatch.setenv("KIROCREW_HOME", str(scratch))
        monkeypatch.delenv("KIRO_HOME", raising=False)

        adopted = adopt_isolated_kiro_home()

        assert adopted == isolated_kiro_home(scratch.resolve())
        assert os.environ["KIRO_HOME"] == str(adopted)
        # The whole point: the agents dir kiro-cli and every writer now resolve
        # is the dedicated one the write guard's private-target exemption admits,
        # not the machine-wide ``~/.kiro/agents``.
        assert paths.kiro_home() == adopted
        assert paths.ambient_agents_dir() == isolated_agents_dir(scratch.resolve())
        assert paths.kiro_sessions_dir().is_relative_to(adopted)

    def test_an_explicit_kiro_home_is_never_overridden(self, monkeypatch, tmp_path):
        """``KIRO_HOME`` set by the operator is a choice -- including naming the
        shared ``~/.kiro`` on purpose -- and the prologue must not second-guess it."""
        _relocate_main_homes(monkeypatch, tmp_path)
        monkeypatch.setenv("KIROCREW_HOME", str(tmp_path / "scratch-home"))
        chosen = tmp_path / "user" / ".kiro"
        monkeypatch.setenv("KIRO_HOME", str(chosen))
        assert adopt_isolated_kiro_home() is None
        assert os.environ["KIRO_HOME"] == str(chosen)

    @pytest.mark.skipif(sys.platform == "win32", reason="/etc is a POSIX system dir")
    def test_an_invalid_kiro_home_is_not_a_choice(self, monkeypatch, tmp_path, caplog):
        """``KIRO_HOME=/etc`` is one ``kiro_home()`` discards, so the process would
        land on the shared ``~/.kiro`` anyway. Treating the raw variable as an
        explicit choice would let ``KIROCREW_HOME=<scratch> KIRO_HOME=/etc``
        bypass the isolation entirely; it is replaced, with a warning."""
        _relocate_main_homes(monkeypatch, tmp_path)
        scratch = tmp_path / "scratch-home"
        scratch.mkdir()
        monkeypatch.setenv("KIROCREW_HOME", str(scratch))
        monkeypatch.setenv("KIRO_HOME", "/etc")
        with caplog.at_level("WARNING", logger="kiro_crew.config.paths"):
            adopted = adopt_isolated_kiro_home()
        assert adopted == isolated_kiro_home(scratch.resolve())
        assert os.environ["KIRO_HOME"] == str(adopted)
        assert "/etc" in caplog.text and "system directory" in caplog.text

    def test_first_adoption_warns_with_the_opt_out(self, monkeypatch, tmp_path, caplog):
        """The upgrade moment for a relocated install: the adopted home does not
        exist yet, so this start is the one that moves its kiro-cli tree. That is
        surfaced at WARNING with the ``KIRO_HOME=~/.kiro`` opt-out, not at INFO."""
        _relocate_main_homes(monkeypatch, tmp_path)
        scratch = tmp_path / "scratch-home"
        scratch.mkdir()
        monkeypatch.setenv("KIROCREW_HOME", str(scratch))
        monkeypatch.delenv("KIRO_HOME", raising=False)
        with caplog.at_level("INFO", logger="kiro_crew.config.paths"):
            adopt_isolated_kiro_home()
        records = [r for r in caplog.records if r.name == "kiro_crew.config.paths"]
        warnings = [r for r in records if r.levelname == "WARNING"]
        assert len(warnings) == 1
        assert "export KIRO_HOME=" in warnings[0].getMessage()
        assert "not yet present" in warnings[0].getMessage()

    def test_a_later_start_logs_info_only(self, monkeypatch, tmp_path, caplog):
        _relocate_main_homes(monkeypatch, tmp_path)
        scratch = tmp_path / "scratch-home"
        isolated_kiro_home(scratch).mkdir(parents=True)  # adopted on an earlier start
        monkeypatch.setenv("KIROCREW_HOME", str(scratch))
        monkeypatch.delenv("KIRO_HOME", raising=False)
        with caplog.at_level("INFO", logger="kiro_crew.config.paths"):
            adopt_isolated_kiro_home()
        records = [r for r in caplog.records if r.name == "kiro_crew.config.paths"]
        assert [r.levelname for r in records] == ["INFO"]

    def test_idempotent(self, monkeypatch, tmp_path):
        _relocate_main_homes(monkeypatch, tmp_path)
        monkeypatch.setenv("KIROCREW_HOME", str(tmp_path / "scratch-home"))
        monkeypatch.delenv("KIRO_HOME", raising=False)
        first = adopt_isolated_kiro_home()
        assert first is not None
        assert adopt_isolated_kiro_home() is None  # already adopted -> no-op
        assert os.environ["KIRO_HOME"] == str(first)

    def test_isolated_agents_dir_derives_from_isolated_kiro_home(self, tmp_path):
        """One definition of the recipe: the write guard's privacy test and the
        exported ``KIRO_HOME`` cannot drift apart."""
        home = tmp_path / "h"
        assert isolated_agents_dir(home) == isolated_kiro_home(home) / "agents"


# --------------------------------------------------------------------------
# The write guard: a non-default data home does not own the shared agents dir
# --------------------------------------------------------------------------
def _pretend_target_is_shared(monkeypatch, agent_mod, agents_dir: Path) -> None:
    """Same seam ``test_agent_home_isolation`` uses: present *agents_dir* as both the
    write target and what the ambient environment resolves."""
    monkeypatch.setattr(agent_mod, "KIRO_AGENTS_DIR", agents_dir)
    monkeypatch.setattr(agent_mod, "ambient_agents_dir", lambda: agents_dir)


def _durable_primary_checkout(monkeypatch, agent_mod) -> None:
    """The failing shape: NOT a linked worktree, NOT under the temp root."""
    monkeypatch.setattr(agent_mod, "__file__", "/durable-install/KiroCrew/src/kiro_crew/agent.py")


def _capture_sel(monkeypatch, agent_mod) -> list[dict]:
    events: list[dict] = []

    class _Sel:
        def log_api_access(self, **kw):
            events.append(kw)

    monkeypatch.setattr(agent_mod, "sel", lambda: _Sel())
    return events


class TestWriteGuardRefusesForeignHome:
    def test_scratch_home_without_kiro_home_is_declined_and_audited(self, monkeypatch, tmp_path):
        """The reproduction, at the guard: ``KIROCREW_HOME=<scratch>``, no
        ``KIRO_HOME``, durable checkout, shared target -> refused, not written."""
        from kiro_crew import agent

        _relocate_main_homes(monkeypatch, tmp_path)
        events = _capture_sel(monkeypatch, agent)
        scratch = tmp_path / "scratch-home"
        scratch.mkdir()
        monkeypatch.setenv("KIROCREW_HOME", str(scratch))
        monkeypatch.delenv("KIRO_HOME", raising=False)
        monkeypatch.delenv("KIROCREW_POD", raising=False)
        _durable_primary_checkout(monkeypatch, agent)
        shared = tmp_path / "user" / ".kiro" / "agents"
        _pretend_target_is_shared(monkeypatch, agent, shared)

        declined = agent._decline_shared_agent_home()

        assert declined == shared / agent.AGENT_FILENAME
        denied = [e for e in events if e.get("outcome") == "denied"]
        assert len(denied) == 1, events
        assert denied[0]["operation"] == "agent_home_write"
        assert str(shared) in denied[0]["resources"]
        assert str(isolated_agents_dir(scratch.resolve())) in denied[0]["error"]

    def test_rebuild_writes_nothing_from_a_scratch_home(self, monkeypatch, tmp_path):
        """End to end through ``rebuild_agent_config``: the shared dir is untouched."""
        from kiro_crew import agent

        _relocate_main_homes(monkeypatch, tmp_path)
        _capture_sel(monkeypatch, agent)
        scratch = tmp_path / "scratch-home"
        scratch.mkdir()
        monkeypatch.setenv("KIROCREW_HOME", str(scratch))
        monkeypatch.delenv("KIRO_HOME", raising=False)
        monkeypatch.delenv("KIROCREW_POD", raising=False)
        _durable_primary_checkout(monkeypatch, agent)
        shared = tmp_path / "user" / ".kiro" / "agents"
        _pretend_target_is_shared(monkeypatch, agent, shared)

        returned = agent.rebuild_agent_config()

        assert returned == shared / agent.AGENT_FILENAME
        assert not shared.exists(), "a non-default data home must not create the shared agent home"

    def test_the_refusal_names_the_remedy(self, monkeypatch, tmp_path, caplog):
        from kiro_crew import agent

        _relocate_main_homes(monkeypatch, tmp_path)
        _capture_sel(monkeypatch, agent)
        scratch = tmp_path / "scratch-home"
        scratch.mkdir()
        monkeypatch.setenv("KIROCREW_HOME", str(scratch))
        monkeypatch.delenv("KIRO_HOME", raising=False)
        monkeypatch.delenv("KIROCREW_POD", raising=False)
        _durable_primary_checkout(monkeypatch, agent)
        _pretend_target_is_shared(monkeypatch, agent, tmp_path / "user" / ".kiro" / "agents")

        with caplog.at_level("WARNING", logger="kiro_crew.agent"):
            agent._decline_shared_agent_home()

        text = "\n".join(r.getMessage() for r in caplog.records)
        assert "non-default data home" in text
        assert f"KIRO_HOME={isolated_kiro_home(scratch.resolve())}" in text

    def test_adopted_kiro_home_makes_the_target_private(self, monkeypatch, tmp_path):
        """With the prologue's export in force the instance writes its OWN specs:
        the target is ``isolated_agents_dir(own home)`` and the guard stands aside.
        Being refused would not be harmless here -- it would hand this instance the
        shared spec, whose env pins the LIVE data home."""
        from kiro_crew import agent

        _relocate_main_homes(monkeypatch, tmp_path)
        scratch = tmp_path / "scratch-home"
        scratch.mkdir()
        monkeypatch.setenv("KIROCREW_HOME", str(scratch))
        monkeypatch.delenv("KIRO_HOME", raising=False)
        monkeypatch.delenv("KIROCREW_POD", raising=False)
        assert adopt_isolated_kiro_home() is not None
        _durable_primary_checkout(monkeypatch, agent)
        _pretend_target_is_shared(monkeypatch, agent, isolated_agents_dir(scratch.resolve()))

        assert agent._decline_shared_agent_home() is None

    def test_explicit_kiro_home_naming_the_shared_dir_is_the_opt_in(self, monkeypatch, tmp_path):
        """A relocated install that WANTS to keep sharing ``~/.kiro`` says so with
        ``KIRO_HOME``; the ownership arm then defers to the ephemerality arms, and a
        durable checkout is allowed through like any ordinary install."""
        from kiro_crew import agent

        _relocate_main_homes(monkeypatch, tmp_path)
        events = _capture_sel(monkeypatch, agent)
        monkeypatch.setenv("KIROCREW_HOME", str(tmp_path / "relocated-home"))
        shared_kiro = tmp_path / "user" / ".kiro"
        monkeypatch.setenv("KIRO_HOME", str(shared_kiro))
        monkeypatch.delenv("KIROCREW_POD", raising=False)
        _durable_primary_checkout(monkeypatch, agent)
        _pretend_target_is_shared(monkeypatch, agent, shared_kiro / "agents")

        assert agent._decline_shared_agent_home() is None
        assert [e["outcome"] for e in events] == ["allowed"]

    def test_default_home_still_owns_the_shared_dir(self, monkeypatch, tmp_path):
        """The ordinary install is unchanged: no override, durable checkout -> writes."""
        from kiro_crew import agent

        _relocate_main_homes(monkeypatch, tmp_path)
        events = _capture_sel(monkeypatch, agent)
        monkeypatch.delenv("KIROCREW_HOME", raising=False)
        monkeypatch.delenv("KIRO_HOME", raising=False)
        monkeypatch.delenv("KIROCREW_POD", raising=False)
        _durable_primary_checkout(monkeypatch, agent)
        _pretend_target_is_shared(monkeypatch, agent, tmp_path / "user" / ".kiro" / "agents")

        assert agent._decline_shared_agent_home() is None
        assert [e["outcome"] for e in events] == ["allowed"]

    @pytest.mark.skipif(sys.platform == "win32", reason="/etc is a POSIX system dir")
    def test_an_invalid_kiro_home_is_not_an_opt_in(self, monkeypatch, tmp_path):
        """``KIRO_HOME=/etc`` is discarded by ``kiro_home()``, so the target is the
        shared dir after all; the raw variable being set must not read as the
        operator's consent to write it."""
        from kiro_crew import agent

        _relocate_main_homes(monkeypatch, tmp_path)
        events = _capture_sel(monkeypatch, agent)
        monkeypatch.setenv("KIROCREW_HOME", str(tmp_path / "scratch-home"))
        monkeypatch.setenv("KIRO_HOME", "/etc")
        monkeypatch.delenv("KIROCREW_POD", raising=False)
        _durable_primary_checkout(monkeypatch, agent)
        _pretend_target_is_shared(monkeypatch, agent, tmp_path / "user" / ".kiro" / "agents")

        assert agent._decline_shared_agent_home() is not None
        assert [e["outcome"] for e in events] == ["denied"]


# --------------------------------------------------------------------------
# kirocrew doctor: name the drifted pin
# --------------------------------------------------------------------------
def _write_spec(agents_dir: Path, name: str, servers: dict) -> Path:
    agents_dir.mkdir(parents=True, exist_ok=True)
    p = agents_dir / name
    p.write_text(json.dumps({"name": name[:-5], "mcpServers": servers}), encoding="utf-8")
    return p


class TestDoctorSpecHomeDrift:
    @pytest.fixture
    def own_home(self, monkeypatch, tmp_path: Path) -> Path:
        home = tmp_path / "gateway-home"
        home.mkdir()
        monkeypatch.setenv("KIROCREW_HOME", str(home))
        return home.resolve()

    def test_a_managed_spec_pinning_another_home_is_drift(self, own_home, tmp_path):
        from kiro_crew.doctor_spec_home import check_spec_home_drift

        agents = tmp_path / "agents"
        foreign = tmp_path / "scratch" / "runtime-3c0a7e8b" / "pfshot" / "home"
        _write_spec(
            agents,
            "kirocrew.json",
            {
                "kirocrew-core": {"command": "kirocrew", "env": {"KIROCREW_HOME": str(foreign)}},
                "kirocrew-cron": {"command": "kirocrew", "env": {"KIROCREW_HOME": str(foreign)}},
                "other-tool": {"command": "x"},
            },
        )

        report = check_spec_home_drift(agents_dir=agents)

        assert report.expected == str(own_home)
        assert report.scanned == 1
        assert sorted(d.server for d in report.managed) == ["kirocrew-core", "kirocrew-cron"]
        assert all(d.pinned == str(foreign) and d.managed for d in report.drift)
        assert report.foreign == []

    def test_a_matching_pin_and_no_pin_are_both_healthy(self, own_home, tmp_path):
        from kiro_crew.doctor_spec_home import check_spec_home_drift

        agents = tmp_path / "agents"
        _write_spec(
            agents,
            "kirocrew.json",
            {
                # Pinned to OUR home, spelled with a trailing slash.
                "kirocrew-core": {"command": "kirocrew", "env": {"KIROCREW_HOME": f"{own_home}/"}},
                # A default-home writer pins nothing; not a finding.
                "kirocrew-cron": {"command": "kirocrew"},
            },
        )
        report = check_spec_home_drift(agents_dir=agents)
        assert report.drift == []
        assert report.scanned == 1

    def test_a_foreign_spec_is_reported_apart_from_managed_ones(self, own_home, tmp_path):
        from kiro_crew.doctor_spec_home import check_spec_home_drift

        agents = tmp_path / "agents"
        _write_spec(
            agents,
            "some-aim-agent.json",
            {"kirocrew-core": {"command": "kirocrew", "env": {"KIROCREW_HOME": "/elsewhere"}}},
        )
        report = check_spec_home_drift(agents_dir=agents)
        assert report.managed == []
        assert [d.spec for d in report.foreign] == ["some-aim-agent.json"]

    def test_malformed_specs_are_skipped_not_fatal(self, own_home, tmp_path):
        from kiro_crew.doctor_spec_home import check_spec_home_drift

        agents = tmp_path / "agents"
        agents.mkdir()
        (agents / "broken.json").write_text("{not json", encoding="utf-8")
        (agents / "list.json").write_text("[1, 2]", encoding="utf-8")
        _write_spec(agents, "kirocrew.json", {"kirocrew-core": {"env": "not-an-object"}})
        report = check_spec_home_drift(agents_dir=agents)
        assert report.scanned == 1  # only kirocrew.json parsed as an object
        assert report.drift == []

    def test_missing_agents_dir_is_empty_not_an_error(self, own_home, tmp_path):
        from kiro_crew.doctor_spec_home import check_spec_home_drift

        report = check_spec_home_drift(agents_dir=tmp_path / "nope")
        assert report.scanned == 0 and report.drift == []

    def test_renderer_flags_managed_drift_with_the_remedy(self, own_home, tmp_path, capsys):
        from kiro_crew.doctor_spec_home import doctor_spec_home_drift

        agents = tmp_path / "agents"
        _write_spec(
            agents,
            "kirocrew.json",
            {"kirocrew-core": {"command": "kirocrew", "env": {"KIROCREW_HOME": "/scratch/x"}}},
        )
        issues: list[str] = []
        doctor_spec_home_drift(issues, agents_dir=agents)
        out = capsys.readouterr().out
        assert "Agent Spec Data Home" in out
        assert "kirocrew.json" in out and "KIROCREW_HOME=/scratch/x" in out
        assert "kirocrew setup --agent-only" in out
        assert issues == ["agent specs pin a different KIROCREW_HOME than this data home"]

    def test_renderer_is_green_and_silent_in_issues_when_healthy(self, own_home, tmp_path, capsys):
        from kiro_crew.doctor_spec_home import doctor_spec_home_drift

        agents = tmp_path / "agents"
        _write_spec(agents, "kirocrew.json", {"kirocrew-core": {"command": "kirocrew"}})
        issues: list[str] = []
        doctor_spec_home_drift(issues, agents_dir=agents)
        assert "✅" in capsys.readouterr().out
        assert issues == []

    def test_renderer_neutralizes_terminal_controls_in_a_pin(self, own_home, tmp_path, capsys):
        """A spec is untrusted input; an escape byte in its pin must not reach the
        terminal raw (same rule as the dead-path check)."""
        from kiro_crew.doctor_spec_home import doctor_spec_home_drift

        agents = tmp_path / "agents"
        _write_spec(
            agents,
            "kirocrew.json",
            {"kirocrew-core": {"env": {"KIROCREW_HOME": "/x\x1b]0;pwned\x07"}}},
        )
        doctor_spec_home_drift([], agents_dir=agents)
        out = capsys.readouterr().out
        assert "\x1b" not in out and "\\x1b" in out

    @requires_symlinks
    def test_specs_are_read_through_the_hardened_gate(self, own_home, tmp_path, monkeypatch):
        """Every spec read goes through ``agent_discovery._read_agent_spec`` -- the
        one reader that refuses a symlink whose RESOLVED target is sensitive and
        caps the size -- never a bare ``read_text``. Driven through the reader's
        own sensitive-path refusal, the way the hardened-read suite does."""
        from kiro_crew import agent_discovery
        from kiro_crew.doctor_spec_home import check_spec_home_drift

        agents = tmp_path / "agents"
        agents.mkdir()
        protected = tmp_path / "protected.json"
        protected.write_text(
            json.dumps({"mcpServers": {"kirocrew-core": {"env": {"KIROCREW_HOME": "/x"}}}}),
            encoding="utf-8",
        )
        (agents / "kirocrew.json").symlink_to(protected)
        monkeypatch.setattr(
            agent_discovery, "is_sensitive_path", lambda p: str(protected) in str(p)
        )

        report = check_spec_home_drift(agents_dir=agents)

        assert report.scanned == 0, "a link to a protected target must not be parsed"
        assert report.drift == []


# --------------------------------------------------------------------------
# Wiring ratchets
# --------------------------------------------------------------------------
def test_cli_prologue_adopts_the_kiro_home_after_the_data_home():
    """Every ``kirocrew`` verb shares one prologue; the adoption must sit in it,
    after ``ensure_data_home()`` (the override is validated there) and before any
    subcommand dispatch. Source-level so the ordering itself is what is pinned."""
    src = (REPO_ROOT / "src" / "kiro_crew" / "cli.py").read_text(encoding="utf-8")
    body = src.split("def main(", 1)[1]
    ensure_at = body.index("ensure_data_home()")
    adopt_at = body.index("adopt_isolated_kiro_home()")
    dispatch_at = body.index("if args.command is None:")
    assert ensure_at < adopt_at < dispatch_at


def test_doctor_runs_the_spec_home_check_beside_the_trust_root():
    src = (REPO_ROOT / "src" / "kiro_crew" / "cli_doctor.py").read_text(encoding="utf-8")
    assert re.search(
        r"_doctor_trust_root\(\)\s*\n(?:\s*#.*\n)*\s*doctor_spec_home_drift\(issues, agents_dir=_agents_dir\(\)\)",
        src,
    ), "doctor must run the spec-home drift check right after the trust-root check"


def test_cli_prologue_reprimes_the_unc_agents_root_after_adopting():
    """``hooks`` memoizes the agents dir (the UNC gate's trusted root) keyed on
    KIRO_HOME and primes it at import, which precedes the prologue. After the
    export the memo is stale and the FIRST gate check would resolve the path on
    whatever thread asked -- the event loop, on a UNC home an SMB round-trip. Both
    prologues must re-prime synchronously when they adopted."""
    for rel in ("cli.py", "mcp_gateway/gatewayd.py"):
        src = (REPO_ROOT / "src" / "kiro_crew" / rel).read_text(encoding="utf-8")
        adopt_at = src.index("if adopt_isolated_kiro_home() is not None:")
        tail = src[adopt_at : adopt_at + 800]
        assert "prime_unc_agents_root()" in tail, f"{rel}: adoption without a re-prime"
