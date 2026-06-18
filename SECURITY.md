# Security Policy

## Threat model (read this first)

VibeOps Tracker is **local-first and localhost-only by design**. The server binds to
`localhost`, has **no authentication**, and allows any origin (CORS `*`) so the
embeddable widget can post from your other apps. State-changing requests from a
browser are restricted to same-origin to blunt drive-by CSRF, but the core
assumption stands:

> **Do not expose the VibeOps Tracker port (default 4400) to a network you don't
> trust.** It is meant to run on your own machine, for you.

Your issue data lives in a local `data/` directory and is never transmitted
anywhere. There is no telemetry, no account, and no cloud component.

## Supported versions

This is an early project; security fixes land on the latest release.

| Version | Supported |
| ------- | --------- |
| 0.1.x   | ✅        |

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Email
**igor@canaryaware.com** with:

- a description of the issue and its impact,
- steps to reproduce (or a proof of concept), and
- any suggested fix.

You'll get an acknowledgement, and I'll work with you on a fix and disclosure
timeline. Thanks for helping keep VibeOps Tracker users safe.
