# Security and dependency assurance

Read when a change affects untrusted input, identity, permissions, sensitive data, dependencies, or privileged automation. Existing execution-safety rules remain in force; this guide concerns the software being produced.

## Trust boundaries and misuse

**Do:** identify the affected asset, trust boundary, plausible misuse, mitigation, and verification. Revisit this assessment when the boundary changes. Validate input at entry, enforce authorization at access, and use established secure APIs and libraries.
**Do not:** treat client input as authority, or use a clean scanner result as proof that business authorization is correct.

Bad:

```ts
return orders.forTenant(request.tenantId); // Authentication alone proves no tenant access.
```

Good:

```ts
const tenant = authorizeTenant(principal, request.tenantId);
return orders.forTenant(tenant.id);
// Verify both permitted access and cross-tenant denial.
```

**Exception:** a local pure helper with already validated values needs no separate threat-model document or redundant boundary checks. A new public or privilege boundary warrants deeper analysis even in a small diff.

## Sensitive data and failure

**Do:** keep secrets out of source and logs, minimize sensitive data exposure, and make denied or failed operations preserve the documented security state.
**Do not:** log full credentials for debugging or silently turn authorization-service failure into access permission.

Bad: log the complete request, including access tokens, when an upstream call fails.
Good: record a safe correlation ID, operation, and error category; test redaction where sensitive fields enter the logger.

**Exception:** a documented degraded mode can remain available when it preserves the relevant access rules. Availability is not permission to grant broader access.

## Privileged automation

**Do:** bound credentials, permissions, destinations, and executable inputs to the automation's task. Distinguish trusted workflow logic from untrusted change content.
**Do not:** execute untrusted PR code with publishing credentials, or interpolate untrusted values as shell source.

Bad: a short CI job evaluates a PR-controlled script while a release token is available.
Good: separate untrusted validation from the authorized release job, pass data as data, and grant only the release job's required permissions.

**Exception:** a local credential-free script needs straightforward quoting and error handling, not a new deployment platform. Small size does not remove an existing privilege boundary.

## Dependencies and artifacts

**Do:** evaluate present simplification, maintenance/support, API fit, relevant vulnerabilities, update path, and operational burden. Preserve the project's lockfile/update convention. Fix relevant findings with evidence rather than reflexively replacing every dependency.
**Do not:** reject a useful ORM for having one consumer, or add a package whose lifecycle burden exceeds the behavior it removes.

Bad: introduce a large framework for three obvious lines; alternatively, rebuild required transactions and migrations just to avoid a dependency.
Good: choose the simplest complete solution, including the dependency's maintenance and upgrade costs.

For published/deployed artifacts, preserve build inputs and artifact identity through the established pipeline. Verify available provenance against expected source/build identity. Provenance establishes origin/process claims, not application correctness. Apply stronger source/build assurances when distribution and threat model warrant them.

Bad: rebuild locally after CI and publish a different artifact while citing CI as its proof.
Good: release the verified artifact from the intended revision and check its identity and applicable attestations.

**Exception:** a local one-off tool needs no attestation infrastructure. Reuse project mechanisms; do not mandate SLSA levels or new scanners for every repository.

## Sources and status

- [OWASP threat modeling guidance](https://cheatsheetseries.owasp.org/cheatsheets/Threat_Modeling_Cheat_Sheet.html) provides a repeatable boundary/misuse/mitigation/verification approach.
- [NIST SSDF 1.1](https://csrc.nist.gov/pubs/sp/800/218/final) is the final February 2022 publication. The [SSDF 1.2 page](https://csrc.nist.gov/pubs/sp/800/218/r1/ipd) was still labeled Initial Public Draft when checked on 2026-10-07; verify status before making standards claims. This guide imposes no compliance certification.
- [SLSA 1.2 tracks](https://slsa.dev/spec/v1.2/tracks) distinguish source and build assurance. Adopt controls for actual distribution risks.
