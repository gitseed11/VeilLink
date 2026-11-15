# Security Policy

## Supported versions

Only the latest release is supported with security fixes. At this time that is 1.1.x.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub Security Advisories:

1. Open the repository's **Security** tab.
2. Choose **Advisories** → **Report a vulnerability**.
3. Include the affected version, a minimal reproduction, and the impact.

Do not open a public issue for an unpatched vulnerability. Do not include real API keys, admin tokens, tunnel credentials, prompts, or personal data in the report. If a secret may have been exposed, rotate it before reporting.

This is a single-maintainer project; reports are handled on a best-effort basis. We aim to acknowledge valid reports within 7 days.

## Scope

In scope: the VeilLink server, admin UI, protocol passthrough, authentication and authorization, secret handling, and tunnel/startup scripts in this repository.

Out of scope: vulnerabilities in upstream model providers or gateways, Cloudflare's edge, third-party clients, and issues that require a compromised local administrator account or physical access to the host.
