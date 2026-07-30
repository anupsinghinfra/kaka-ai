#!/usr/bin/env bash
#
# Golden-path canary — the post-deploy gate of the platform pipeline
# (EXECUTION.md §1: platform deploys complete only if the canary passes).
#
# M0: stub. M1 replaces the body below with the real run:
#   fork → build → preview → verify → promote → rollback
# against a synthetic venture, under 5 minutes end to end. The pipeline
# invokes this script by path (infra/lib/pipelines/pipeline-stack.ts
# CANARY_SCRIPT_PATH), so swapping the body requires no pipeline change.
set -euo pipefail

echo "=================================================================="
echo "  CANARY STUB — replace with golden-path run (M1)"
echo "  fork -> build -> preview -> verify -> promote -> rollback"
echo "  This stub exits 0 and gates nothing. Do not ship M1 without it."
echo "=================================================================="

exit 0
