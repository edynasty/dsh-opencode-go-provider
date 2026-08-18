# Security Policy

## Supported scope

`dsh-opencode-go-provider` is a community plugin for DeepSeek Harness
(DSH rc.7). Supported surfaces:

- The commit-pinned Git installation of this repository
  (`github:edynasty/dsh-opencode-go-provider#<verified-sha>`).
- The Host provider registration, the Web Connect card, the control routes,
  the standalone diagnostic `bin`, and the stale-while-revalidate catalog
  lifecycle described in [README.md](README.md).
- DSH rc.7 hosts only. Unsupported DSH versions are out of scope, and the
  package does not claim compatibility with them.

The npm registry is not an installation path for this package; npm-published
copies are not supported.

## Reporting a vulnerability

Please report vulnerabilities **privately** — do not open a public issue that
reproduces a credential-handling or data-exposure problem.

The private reporting route for this repository is **GitHub private
vulnerability reporting**: open a draft security advisory from the
repository's Security tab. Publication must enable and verify that feature on
the public repository; after the remote release step it is the supported
reporting route for this project.

In your report, include:

- The affected commit SHA or version, and the DSH rc.7 profile layout.
- A minimal reproducer that does **not** contain real credentials.
- Whether the issue involves credentials, cache files, migration files or
  network behavior.

We aim to acknowledge reports within 5 business days and to provide a fix or
mitigation within a reasonable window. Security fixes land as new commit-pinned
Git revisions; re-pin your profile to the fixed SHA.

## Credential handling

- API keys are stored and resolved **only** through the DSH credentials
  service under the ref `OPENCODE_GO_API_KEY`, at operation time.
- Keys are never written into settings, the catalog, cache files, logs,
  errors, the tarball or Git history.
- Disconnect removes only this plugin's credential; it never touches other
  credentials, providers or the route registration.
- Please do not reproduce secrets in issues, PRs, fixtures or documentation.

## Safe diagnostics

`status`, `doctor`, and the web control routes emit sanitized facts only:
fixed error codes, counts, timestamps and sources. They never echo keys,
authorization headers, response bodies, machine paths or user-controlled
payload fragments. If you believe a diagnostic path leaks data, treat it as a
security issue and report it privately.

## No secret reproduction

This project's tests deliberately use fixture-only fake secrets that are
allowlisted and never shipped; the packed-artifact audit rejects any
credential-shaped or machine-path content. Do not add real credentials to
fixtures, evidence, docs or the package.

## Update policy

- Installations are commit-pinned Git dependencies; verify the SHA before
  re-pinning.
- The stale-while-revalidate catalog and the migration tooling are versioned
  with the package; breaking changes are documented in the README.
- Security advisories, when any, are published through GitHub advisories for
  this repository.
