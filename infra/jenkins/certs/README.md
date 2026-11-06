# Extra CA certificates (dev builds only, git-ignored)

Behind a TLS-inspecting proxy, the Jenkins plugin download fails certificate verification. Put the proxy's
root certificate here as a PEM `*.crt` file; `infra/jenkins/Dockerfile` adds every `*.crt` in this folder
to the image's Java trust store. Only public CA certificates belong here. `*.crt` files are never committed.

Windows example (exports a root the machine already trusts; pick it by thumbprint):

```powershell
$c = Get-ChildItem Cert:\LocalMachine\Root | Where-Object Thumbprint -eq '<thumbprint>'
"-----BEGIN CERTIFICATE-----`n" + [Convert]::ToBase64String($c.RawData,'InsertLineBreaks') + "`n-----END CERTIFICATE-----" |
  Set-Content -Encoding ascii infra\jenkins\certs\proxy-root.crt
```
