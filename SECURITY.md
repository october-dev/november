# Security policy

November is in early design. It has no installable release or qualified deployment, and is not ready for unattended or safety-critical use. Reports about the repository, proposed security boundaries, and future implementation are welcome.

## Reporting a vulnerability

Email [hey@october.dev](mailto:hey@october.dev) with the subject **November security report**. This is October's [published contact address](https://www.october.dev/contact); use it to reach the maintainers privately. Send a short, sanitized summary first and coordinate any sensitive follow-up directly with them.

Do not report an undisclosed vulnerability or exposed secret in a public issue, pull request, discussion, or public attachment. November's upstream GitHub private vulnerability-reporting form is not enabled as of 2026-09-10; this policy uses email rather than directing reporters to an unavailable form.

Include, without real credentials or private device data:

- The affected version or commit and relevant configuration, OS, board, or firmware details.
- The expected security boundary, how it was crossed, and the potential impact.
- Minimal reproduction steps or a proof of concept using synthetic data and a low-risk fixture, plus sanitized logs if needed.
- Any known mitigation or suggested fix.

If a report concerns an exposed secret, identify its location without repeating its value. Revoke or rotate credentials you control and coordinate removal of published copies with the maintainers. A private reporting channel is not a reason to send customer data, personal credentials, or complete session transcripts.

Maintainers review reports on a best-effort basis and coordinate remediation and disclosure with the reporter. There is no guaranteed response or patch deadline. Share only sanitized findings and regression cases publicly after coordinated disclosure. The [publication rules](CONTRIBUTING.md#publishable-content) also apply to security fixes and release evidence.

## Supported versions

| Version | Security support |
| --- | --- |
| Current `main` during early design | Reports and design corrections are accepted; this is not a supported runtime or deployment. |
| Released versions | None exist as of 2026-09-10. There is currently no released version receiving security updates. |

When releases begin, security fixes will target the latest stable release. Older releases and development snapshots will not receive backports unless a maintainer explicitly documents an additional supported line here. Maintainers must update this table when the first release is published and whenever support changes.

## Updates and disclosure

Once releases exist, maintainers will publish sanitized advisories or release notes identifying affected versions, fixed versions, and any available mitigation. Users should move to the fixed supported version; staying on an older release does not extend its support.

Apply device updates explicitly using the documented installation/update procedure for that release. Review the affected hardware/configuration, migration or recovery instructions when applicable, and rollback procedure before deployment. Do not treat tracking `main` or silently updating a deployed device as a security-update strategy. Package verification, update, and rollback implementation is tracked in [#24](https://github.com/october-dev/november/issues/24); none is available yet.

Maintainers must keep the reporting contact reachable and this policy current. No report or release approval should claim a security fix, hardware qualification, or support period without the corresponding evidence.
