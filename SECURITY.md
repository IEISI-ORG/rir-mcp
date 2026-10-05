# Security policy

## Reporting a vulnerability

Please report security problems privately, not in a public issue:

1. Open the repository's **Security** tab on GitHub.
2. Choose **Report a vulnerability** and describe the problem, how to reproduce it, and its impact.

Please do not include personal data from RDAP records in a report. If you need to show registry data, use a public role or organisation record.

We aim to acknowledge reports within a few working days and to fix confirmed issues before disclosing them.

## Scope

In scope: this repository's code (the stdio and HTTP servers, the Cloudflare Worker, the key tools) and its documentation, including anything that could:

- return, store or log personal data from registry records;
- let a client bypass authentication, quotas, call-rate limits or scan detection;
- let the server exceed a registry's rate limits or ignore its `Retry-After`;
- put links, images, HTML or formatting from registry data into answers;
- leak API keys or query values into logs.

Out of scope: the registries' own RDAP services, and deployments run by third parties (report those to their operators).
