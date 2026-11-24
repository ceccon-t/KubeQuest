# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] - YYYY-MM-DD

### Added

- App version shown under the KUBEQUEST title
- Full curriculum: 28 new tickets (42 in total)
- Workstation tools: `helm` (v3, local charts), `git` (single branch and remote), `base64`
- Sandbox: default StorageClass and an ingress controller

### Changed

- Events behave like upstream: similar events are combined after ten, and events expire one hour after
  their last update
- Controllers retry refused Pod creates with client-go's back-off (5 ms doubling to 1000 s)
- Mission 3.8 no longer has an SLO

### Deprecated

### Removed

### Fixed

- `kubectl describe` no longer prints the last-applied-configuration annotation; node resource
  percentages are truncated, not rounded, and zero quantities print as `0`
- `curl -s` is silent on errors (use `-sS`); busybox `wget -T` is accepted and reports time-outs
- A Pod that was never scheduled is removed immediately when deleted
- A Deployment that exceeded its progress deadline progresses again when a new ReplicaSet is created
- Job pod templates and PersistentVolumeClaim specs are immutable; StatefulSet updates are restricted
  to the fields upstream allows
- A Job manifest without `template.metadata` no longer breaks the Job controller
- Here-documents (`<<EOF`) give an explicit "not supported" message

### Security


## [0.1.0] - 2026-10-31

### Added

- Initial release
- Core gameplay loop
- Campaign of 14 tickets across Chapters 0–4 of the curriculum (orientation, images, kubectl fluency, workloads, Services), each with a briefing, field notes, objectives, insights and a debrief with score and stars, plus a free-play Sandbox
- Simulated production cluster that reacts live on screen
- Terminal with a `kubectl` simulator targeting v1.32 output and semantics, Tab completion, a YAML editor and the usual workstation commands
