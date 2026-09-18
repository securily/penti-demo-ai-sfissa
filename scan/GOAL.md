# GOAL — close the missing-header finding

Northstar already ran OWASP ZAP. The results are in scan/zap-report.json.
One finding remains: Content-Security-Policy is not set on /login.

DOD means Definition of Done — the checklist of what we are set to complete.
One DOD row per turn. Do not skip ahead.

Read the ZAP results. Read the login handler. Write the fix.

```dod
DOD-01 | unchecked | cmd | see-finding | scan | scan/zap-report.json | See the CSP finding
DOD-02 | unchecked | cmd | see-code | scan | app/login.py | See the login handler
DOD-03 | unchecked | cmd | write-fix | scan | fix/csp.py | Write the CSP fix
```
