# GOAL — close the missing-header finding

Northstar already ran a canned OWASP ZAP baseline.
One finding remains: Content-Security-Policy is not set on /login.

Read the report. Read the login handler. Write the fix.

One slice per loop.

```dod
DOD-01 | unchecked | cmd | see-finding | scan | scan/zap-report.json | See the CSP finding
DOD-02 | unchecked | cmd | see-code | scan | app/login.py | See the login handler
DOD-03 | unchecked | cmd | write-fix | scan | fix/csp.py | Write the CSP fix
```
