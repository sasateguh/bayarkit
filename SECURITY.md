# Security policy

Please report vulnerabilities privately through GitHub's
[private vulnerability reporting](../../security/advisories/new) for this repository, not in a public issue.

In scope: anything that lets a payment be confirmed when it should not be (signature checks, `confirmPayment`,
callback parsing), or that leaks a gateway key or secret into errors or logs.

Security fixes go to the latest release. Older releases are not patched.
