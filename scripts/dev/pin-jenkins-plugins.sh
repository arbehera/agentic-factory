#!/usr/bin/env bash
# Re-resolves the Jenkins plugins (and every dependency) for the pinned controller image and rewrites
# infra/jenkins/plugins.txt. Review the diff like any dependency change (CLAUDE.md §9).
set -euo pipefail
cd "$(dirname "$0")/../.."
export DOCKER_HOST="${DOCKER_HOST:-unix:///run/user/$(id -u)/docker.sock}"
# shellcheck disable=SC1091
. infra/compose/images.env
roots="configuration-as-code workflow-aggregator git github-branch-source pipeline-githubnotify-step matrix-auth"
certs=()
for c in infra/jenkins/certs/*.crt; do [ -f "$c" ] && certs+=(-v "$PWD/$c:/tmp/extra-ca/$(basename "$c"):ro"); done
list="$(docker run --rm --user root "${certs[@]}" "$JENKINS_IMAGE" sh -c "
  for c in /tmp/extra-ca/*.crt; do [ -f \"\$c\" ] && keytool -importcert -noprompt -cacerts -storepass changeit -alias \"\$(basename \"\$c\")\" -file \"\$c\" >/dev/null; done
  java -jar /usr/share/jenkins/jenkins.war --version; jenkins-plugin-cli --plugins $roots --list")"
version="$(printf '%s\n' "$list" | head -1)"
{
  echo "# Jenkins plugins for the dev/CI controller, every one pinned including dependencies (CLAUDE.md §9)."
  echo "# Resolved $(date -u +%F) for Jenkins $version from: $roots."
  echo "# Re-resolve with scripts/dev/pin-jenkins-plugins.sh."
  printf '%s\n' "$list" | sed -n '/Resulting plugin list/,$p' | tail -n +2 | grep -E '^[a-z0-9._-]+ [^ ]+$' | sed 's/ /:/'
} > infra/jenkins/plugins.txt
echo "pinned: infra/jenkins/plugins.txt (Jenkins $version)"
