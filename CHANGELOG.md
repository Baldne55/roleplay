# Changelog

All notable changes to this project are listed here, newest first.
This project follows [Keep a Changelog](https://keepachangelog.com/) and uses
[Semantic Versioning](https://semver.org/).

## [0.3.1] - 2026-06-04

### Changed

- /ame and /amy now echo the issuer's own action line back to them in
  chat using the same purple shape the nametag overlay renders above
  their head, prefixed with a `> ` marker so the issuer can tell their
  nametag-channel echo apart from a regular /me or /my at a glance:
  /ame shows as `> * Name action`, /amy as `> * Name's action`, while
  /me stays at `* Name action` and /my at `* Name's action`. The
  marker shares the purple RP tint so the line still reads as one
  block. Previously the issuer received a generic `INFO: Roleplay
  action set. It will clear automatically in 5 seconds.` ack which
  read as noise once the floating nametag was doing the announcement
  work and left them without a chat trace of having typed the action.
  Players in range still see the float exactly as before, unprefixed;
  only the issuer's chat surface changed.
