# Changelog

All notable changes to this project are listed here, newest first.
This project follows [Keep a Changelog](https://keepachangelog.com/) and uses
[Semantic Versioning](https://semver.org/).

## [0.3.2] - 2026-06-04

### Fixed

- /pm and /reply no longer let a blocked sender appear to send the
  message. Previously the recipient's `(( PM from ... ))` line was
  silently dropped but the sender still saw their own `(( PM to ... ))`
  ack, which read on the sender's chat surface as a successful send -
  the block was effectively invisible and the blocked player could
  spam the channel without ever realising the messages went nowhere.
  Both sides now drop and the sender receives a neutral `Your message
  could not be delivered.` error that is shaped to look identical to
  the "target is not in the world" error returned for offline targets,
  so the blocker is not outed by the rejection itself.
