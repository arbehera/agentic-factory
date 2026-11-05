// Verify (S5) + evidence (S9) pipeline for product repositories — SKELETON (P0-WP7, FR-CI-001).
// SDD §12.1, §8.5. Shared from adlc-platform; product repos reference it, they do not copy it.
//
// Trust boundaries:
//  - "verify" runs PR code, in the component pack's toolchain image, on build agents. It posts
//    adlc/verify under the CI identity. It has no route to the signing key.
//  - "evidence" runs on the dedicated signer node (label adlc-signer). It never checks out or runs
//    PR code: the signer reads the PR head and statuses from GitHub and the verdicts from the
//    write-once evidence store, then posts adlc/evidence (FR-EVD-002, apps/signer).
//
// Placeholders until later work packages and sandbox access (plan Q-04):
//  - ADLC_PACK_VERIFY: the pack adapters' verify entry point (BuildAdapter + AnalysisAdapter, P3-WP7).
//  - ADLC_SIGNER_CLI: the signer CLI, added with the real GitHub client (Q-04).
//  - The agent labels and the credentials IDs below are not configured on any Jenkins yet.
pipeline {
  agent none
  options {
    timeout(time: 25, unit: 'MINUTES')   // NFR-003 verify target (pack-dependent)
    disableConcurrentBuilds(abortPrevious: true)
    skipDefaultCheckout()
  }
  environment {
    ADLC_PACK_VERIFY = 'adlc-pack-verify'   // placeholder: provided by the component pack image
    ADLC_SIGNER_CLI = 'adlc-signer'         // placeholder: apps/signer CLI on the signer node
  }
  stages {
    stage('Verify') {
      agent { label 'adlc-build' }
      steps {
        checkout scm
        githubNotify context: 'adlc/verify', status: 'PENDING', description: 'verify running'
        // The pack decides what "verify" means for the component (FR-PCK-001); the core does not.
        sh '"${ADLC_PACK_VERIFY}" --component-from-changed-paths --report verify-report.json'
        archiveArtifacts artifacts: 'verify-report.json', fingerprint: true
      }
      post {
        success { githubNotify context: 'adlc/verify', status: 'SUCCESS', description: 'verify passed' }
        unsuccessful { githubNotify context: 'adlc/verify', status: 'FAILURE', description: 'verify failed' }
      }
    }
    stage('Evidence') {
      // Dedicated signing node: no checkout, no PR code, no build tools (SDD §8.5 S9).
      agent { label 'adlc-signer' }
      when { changeRequest() }
      steps {
        sh '"${ADLC_SIGNER_CLI}" sign --repo "${ADLC_REPO}" --pr "${CHANGE_ID}" --author-role "${ADLC_AUTHOR_ROLE}"'
      }
    }
  }
}
