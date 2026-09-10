# Initial repository and distribution review

Review date: 2026-09-10. Scope: the tracked file contents at upstream `main` commit [`f91665b`](https://github.com/october-dev/november/tree/f91665b01c6e4bd034d814f2dd75f003ec91f55d), their four-commit source history, and the files proposed for [#3](https://github.com/october-dev/november/issues/3). This is a record of content inspection, not a security certification or proof of ownership.

## Inventory and findings

| Material | Review result |
| --- | --- |
| Baseline `README.md` | Public product requirements, planned behavior, and links to public October projects. No private notes, conversations, customer/device data, or credentials were found. Its obsolete license-pending paragraph is replaced by links to the new policies and license. |
| `assets/november-banner.svg` | Inline shapes and text. No scripts, embedded images, external resource loads, private metadata, or bundled font files were found. Font-family names reference installed fonts. The banner is unchanged. |
| New `LICENSE` | Complete Apache License 2.0 text from the [Apache Software Foundation](https://www.apache.org/licenses/LICENSE-2.0.txt), without edits to its terms or appendix. The README identifies the project and contributors to which it applies. |
| New `CONTRIBUTING.md` | Contribution/reproduction instructions, public-content restrictions, and source, dependency, and distribution attribution requirements. |
| New `SECURITY.md` | Private initial contact through October's [published email route](https://www.october.dev/contact), sanitized reporting instructions, present support status, and future update expectations. No claim that the upstream GitHub private-reporting form is enabled. |
| This review record | Public scope, methods, findings, and follow-up ownership only. No private inspection notes or local paths are included. |
| Dependencies and packages | No package manifest, lockfile, vendored code, bundled dependency, binary, or built package exists in the baseline. README references to Pi, October Harness, and October Bus do not distribute their code. No third-party license or `NOTICE` file was found to preserve in this initial inventory. |

## Checks performed

- Listed tracked files and inspected the complete README and SVG, including their source changes across all four commits reachable from the baseline. The historical content contains public product proposals, not private conversations or operational data.
- Reviewed the proposed six-file source snapshot: `README.md`, `assets/november-banner.svg`, `LICENSE`, `CONTRIBUTING.md`, `SECURITY.md`, and this document. Checked text and metadata for credentials, private paths/hostnames, personal or device data, and private notes. The published organizational contact and public source links are intentional.
- Compared `LICENSE` byte-for-byte with Apache's published text; checked local documentation links and whitespace. Inspected the SVG as XML for active or external content.
- Checked a temporary archive of that explicit source inventory. No local configuration, session state, exports, Git metadata, or unrelated files were included. This source snapshot is not an installable package.
- Verified that upstream has no tags or GitHub releases and that its private vulnerability reporting is disabled. Verified the email address against October's public contact page. Email delivery, inbox access, and a security response were not tested; no report was sent.

No prohibited content was found within the reviewed file contents. This review does not cover Git author metadata, other branches, external services, future contributions, or artifacts that do not yet exist.

## Maintainer and release follow-up

A maintainer must approve Apache 2.0 adoption, the contribution/security policies, and this review in the #3 pull request before implementation contributions are accepted. That approval is separate evidence; this record does not assert it has occurred.

Contributors must preserve third-party licenses and required notices under [Reuse and attribution](../CONTRIBUTING.md#reuse-and-attribution). Repeat the content/license review when adding dependencies, copied material, fixtures, or generated files. [#4](https://github.com/october-dev/november/issues/4) owns package/dependency setup; [#24](https://github.com/october-dev/november/issues/24) owns inspection of actual package contents and required notices; [#29](https://github.com/october-dev/november/issues/29) owns the final release-content review. No future package is approved by this initial source review.
