#!/usr/bin/env bash
# Checks that this WSL2 distro runs agent containers the way hard rule 6 requires:
# a rootless Docker daemon with seccomp and cgroup v2 resource limits — not Docker Desktop.
# Usage (inside the WSL distro): scripts/dev/check-rootless-docker.sh
# Exit code 0 = every check passed; 1 = at least one failed. Runbook: docs/runbooks/wsl2-rootless-docker.md
set -u

fails=0
pass() { printf '  [pass] %s\n' "$1"; }
fail() { printf '  [FAIL] %s\n         -> %s\n' "$1" "$2"; fails=$((fails + 1)); }
check() { # check <description> <fix hint> <command...>
  local desc=$1 hint=$2; shift 2
  if "$@" >/dev/null 2>&1; then pass "$desc"; else fail "$desc" "$hint"; fi
}

uid=$(id -u)
sock="/run/user/${uid}/docker.sock"
echo "Rootless Docker checks for $(id -un) (uid ${uid})"

check "running inside WSL2" "run this inside the Ubuntu WSL distro" grep -qi microsoft /proc/sys/kernel/osrelease
check "systemd is PID 1" "set [boot] systemd=true in /etc/wsl.conf, then 'wsl --shutdown' (runbook step 1)" test "$(ps -p 1 -o comm=)" = systemd
check "cgroup v2 (unified) is mounted" "see runbook troubleshooting: cgroup v2" test "$(stat -fc %T /sys/fs/cgroup)" = cgroup2fs
check "newuidmap/newgidmap installed" "sudo apt-get install -y uidmap (runbook step 3)" command -v newuidmap
check "subordinate UIDs are allocated" "add '$(id -un):100000:65536' to /etc/subuid and /etc/subgid" grep -q "^$(id -un):" /etc/subuid

docker_bin=$(command -v docker || true)
if [ -z "$docker_bin" ]; then
  fail "docker CLI present" "install docker-ce-cli (runbook step 4)"
elif readlink -f "$docker_bin" | grep -q docker-desktop; then
  fail "docker CLI is the distro's own, not Docker Desktop's" "turn off Docker Desktop WSL integration for this distro (runbook step 2)"
else
  pass "docker CLI is the distro's own, not Docker Desktop's"
fi

check "docker config has no Docker Desktop credential helper" "remove \"credsStore\": \"desktop.exe\" from ~/.docker/config.json (runbook troubleshooting)" \
  bash -c '! grep -qE "\"creds(Store|Helpers)\"[^}]*desktop" ~/.docker/config.json 2>/dev/null'
check "rootful dockerd is not running" "sudo systemctl disable --now docker.service docker.socket (runbook step 5)" bash -c '! systemctl is-active --quiet docker.service'
check "DOCKER_HOST points at the rootless socket" "export DOCKER_HOST=unix://${sock} in ~/.bashrc (runbook step 6)" test "${DOCKER_HOST:-}" = "unix://${sock}"
check "rootless daemon answers on ${sock}" "systemctl --user start docker; see runbook step 6" docker -H "unix://${sock}" info

secopts=$(docker -H "unix://${sock}" info --format '{{json .SecurityOptions}}' 2>/dev/null || echo "")
check "daemon reports rootless mode" "the daemon on this socket is not rootless; redo runbook step 6" grep -q 'name=rootless' <<<"$secopts"
check "daemon applies the default seccomp profile" "seccomp must not be disabled in the daemon config" grep -q 'name=seccomp' <<<"$secopts"
check "daemon uses cgroup v2" "see runbook troubleshooting: cgroup v2" test "$(docker -H "unix://${sock}" info --format '{{.CgroupVersion}}' 2>/dev/null)" = 2

ctrl="/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service/cgroup.controllers"
for c in cpu memory pids; do
  check "cgroup controller '${c}' delegated to your user" "create /etc/systemd/system/user@.service.d/delegate.conf (runbook step 3)" grep -qw "$c" "$ctrl"
done

# A container with the hard-rule-6 settings must start; limits fail here if delegation is missing.
check "hardened test container runs (read-only, no caps, no-new-privileges, cpu/mem/pids limits)" \
  "read the docker error by running the command from runbook step 7 by hand" \
  docker -H "unix://${sock}" run --rm --read-only --cap-drop ALL --security-opt no-new-privileges \
    --memory 64m --cpus 0.5 --pids-limit 64 --network none hello-world

# WSL appends the Windows PATH, so `node`/`pnpm` may resolve to Windows binaries under /mnt/; those don't count.
linux_cmd() { local p; p=$(command -v "$1") && [ "${p#/mnt/}" = "$p" ]; }
check "Linux Node.js 22 available (not the Windows one)" "install Node 22 inside WSL (runbook step 8)" bash -c "$(declare -f linux_cmd); linux_cmd node && node --version | grep -q '^v22\.'"
check "Linux pnpm available (not the Windows one)" "corepack enable pnpm inside WSL (runbook step 8)" bash -c "$(declare -f linux_cmd); linux_cmd pnpm"

echo
if [ "$fails" -eq 0 ]; then echo "All checks passed."; else echo "${fails} check(s) failed."; fi
[ "$fails" -eq 0 ]
