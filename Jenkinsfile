// Platform repository CI (plan Q-01: Jenkins). Runs the same gate as developers: `pnpm verify`.
// The agent needs Node.js 22 and a Docker daemon (Testcontainers integration tests).
// The agent label is a placeholder until the Jenkins sandbox exists (plan Q-04).
pipeline {
  agent { label 'adlc-platform-ci' }
  options { timeout(time: 30, unit: 'MINUTES'); disableConcurrentBuilds(abortPrevious: true) }
  environment { CI = 'true' }
  stages {
    stage('Toolchain') {
      steps {
        sh 'node --version | grep -q "^v22\." || { echo "Node.js 22 required"; exit 1; }'
        sh 'corepack enable pnpm && pnpm --version'
      }
    }
    stage('Install') { steps { sh 'pnpm install --frozen-lockfile' } }
    stage('Verify')  { steps { sh 'pnpm verify' } }
  }
  post {
    always { archiveArtifacts artifacts: '**/coverage/**', allowEmptyArchive: true }
  }
}
