# Contributing to November

November is in early design. There is no installable package, runtime test suite, or CI yet; package setup belongs to [#4](https://github.com/october-dev/november/issues/4). Device workflows, failure cases, and documentation improvements are useful now.

## Propose a change

1. Check the [upstream issues](https://github.com/october-dev/november/issues) and link the issue your change addresses. For a device proposal, include the board, connection, intended behavior, and what must happen when it fails.
2. Create a focused branch from upstream `main`. Keep changes within the issue's scope and follow the repository's existing approach.
3. Open a pull request against upstream `main`. Explain the problem, resulting behavior, validation performed, and remaining limitations. For behavior changes, include a reproducible regression test when the relevant test setup exists. For documentation, verify links, examples, and `git diff --check`.
4. Review the complete diff and every added file before submitting, using the publication rules below. A maintainer reviews licensing, content, and validation before merging.

Implementation contributions must wait until a maintainer approves and merges the Apache 2.0 license adoption in [#3](https://github.com/october-dev/november/issues/3).

## Reproducible reports and tests

Use public issues for ordinary bugs. For suspected vulnerabilities or exposed secrets, follow [private reporting](SECURITY.md#reporting-a-vulnerability).

Include:

- The affected commit or release, OS/architecture, runtime version when applicable, and relevant board/firmware/configuration versions.
- Minimal, repeatable steps with synthetic inputs and sanitized configuration; expected behavior and actual results.
- Relevant, sanitized logs or a small test case, plus the commands run and their results. State explicitly when a test was not run or hardware was unavailable.
- For hardware failures, the low-risk fixture, wiring, observed output, and recovery behavior. Prefer simulation for reproductions that could energize a device.

Reports and tests must work without personal credentials, customer accounts, or private device data. Use fake providers, synthetic device identifiers, and deterministic inputs where possible. Do not make ordinary tests depend on a paid model account or a live private service. Keep tests that require real hardware explicit and separate from ordinary tests.

## Publishable content

Public documentation, issues, pull requests, commit messages, examples, fixtures, test evidence, and release artifacts must contain only publishable requirements and examples. Exclude private notes, conversations and session transcripts, customer data, personal information, private hostnames/paths/device identifiers, and secrets such as tokens, credentials, keys, or capability URLs.

Write a self-contained public requirement or synthetic reproduction instead of copying private material into an issue. Inspect logs, screenshots, SVG/image metadata, archives, and generated files as well as source text. Use relative paths and invented identifiers in examples. Necessary project contact addresses and public upstream attribution may be included; private contact or device data may not.

Keep local agent/editor configuration, environment files, session state, and diagnostic exports out of submissions and distributions. Removing sensitive text from the working tree does not remove it from an existing commit, attachment, or package. If something sensitive was published, stop copying it and contact the maintainers through [SECURITY.md](SECURITY.md#reporting-a-vulnerability); do not repeat the value in a public report.

## Reuse and attribution

November's original material is distributed under [Apache License 2.0](LICENSE). Contributions intentionally submitted for inclusion use those terms as described in section 5. Submit only work you are authorized to contribute. Public visibility of another repository, image, or snippet is not permission to reuse it.

Before adding a dependency, copied source, or an asset, record its source, exact version or revision, license, and redistribution obligations in the pull request. Check existing dependencies before adding another. Keep the original license and applicable copyright, patent, trademark, attribution, and `NOTICE` content with redistributed material, including packaged dependencies. Mark modifications when the upstream license requires it. November's license does not replace third-party licenses or grant trademark rights.

For each package or release, review the actual archive and dependency inventory, include November's `LICENSE` and all required third-party license/notice files, and exclude private or unrelated files through an explicit artifact allowlist. Packaging implementation belongs to [#24](https://github.com/october-dev/november/issues/24); release review belongs to [#29](https://github.com/october-dev/november/issues/29).

The initial content and license review is recorded in [Repository review](docs/repository-review.md). Update that evidence when the reviewed scope changes; it does not cover future dependencies or release artifacts.
