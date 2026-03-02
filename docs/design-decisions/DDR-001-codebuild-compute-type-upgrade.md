# DDR-001: CodeBuild Compute Type Upgrade — ARM MEDIUM to LARGE

**Date**: 2026-03-01  
**Status**: Accepted  
**Scope**: AiSocialMediaBackendBuild CodeBuild project — compute sizing

## Context

The `AiSocialMediaBackendBuild` CodeBuild project builds up to 14 Docker images in 3 parallel waves (7 + 3 + 4) using `ComputeType.MEDIUM` on `LinuxArmBuildImage.AMAZON_LINUX_2023_STANDARD_3_0`.

CloudWatch metrics (observed over the 5-day window ending 2026-03-01) showed:

- **Memory utilization peaking at ~7.2 GB** — effectively 90% of the 8 GiB available on ARM MEDIUM, risking OOM kills during Wave 1 when 7 concurrent `docker build` processes compete for memory.
- **CPU utilization at 80–100%** — 4 vCPUs saturated by 7 parallel builds, throttling the parallelism gains the wave design was intended to deliver.
- **Build duration 4.3–8.6 min** — slower than expected given the parallel wave architecture, consistent with resource contention.
- **Non-zero failed builds** — memory pressure is the likely contributor during full-rebuild scenarios (BUILD_ALL=true).

## Decision

Upgrade `ComputeType.MEDIUM` → `ComputeType.LARGE` for the backend build project.

### Specs Comparison (AWS ARM on-demand, `ARM_CONTAINER`)

| | ARM MEDIUM (before) | ARM LARGE (after) |
|---|---|---|
| vCPUs | 4 | 8 |
| RAM | 8 GiB | 16 GiB |
| Disk | 128 GB | 128 GB |
| Per-minute price (x86 equiv) | $0.01 | $0.02 |
| Per-minute price (ARM, ~32% discount) | ~$0.0068 | ~$0.0136 |

Source: [AWS CodeBuild compute types](https://docs.aws.amazon.com/codebuild/latest/userguide/build-env-ref-compute-types.html), [AWS CodeBuild pricing](https://aws.amazon.com/codebuild/pricing/)

### Cost Impact

| Metric | MEDIUM | LARGE |
|---|---|---|
| Avg build duration | ~6 min | ~4–5 min (estimated, less contention) |
| Cost per build | ~$0.041 | ~$0.054–$0.068 |
| ~30 builds/month | ~$1.22 | ~$1.63–$2.04 |
| Monthly delta | — | +$0.41–$0.82 |

The cost increase is under $1/month. Builds are also expected to complete faster with doubled vCPUs and RAM headroom, partially offsetting the higher per-minute rate.

## Files Changed

- `cdk/lib/constructs/backend-build-project.ts` — `ComputeType.MEDIUM` → `ComputeType.LARGE`

## Consequences

- Wave 1 (7 parallel Docker builds) gets 8 vCPUs and 16 GiB RAM — sufficient headroom for concurrent Go compilation and Docker layer operations
- Memory utilization drops from ~90% to ~45%, eliminating OOM risk
- CPU contention reduced: 8 vCPUs for 7 concurrent builds means near-1:1 mapping
- Build times should decrease, partially offsetting the 2× per-minute rate increase
- No behavioral or API changes — only the underlying compute resources change

## Rejected Alternatives

- **Keep MEDIUM, reduce parallelism**: Would increase total build time by serializing waves further. The 3-wave design exists specifically to keep builds under 5 min for fast CI feedback.
- **ARM XLARGE (32 vCPUs / 64 GiB)**: Massive overkill for 14 lightweight Go + Docker builds. Cost would jump to ~$0.10/build with no meaningful benefit over LARGE.
- **Split into multiple CodeBuild projects**: Adds operational complexity (multiple buildspecs, artifact coordination) to solve a problem that a simple compute size change fixes.
