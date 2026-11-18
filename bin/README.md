# cloudflared

- File: `cloudflared.exe`
- Version: `2026.11.0`
- Source: https://github.com/cloudflare/cloudflared/releases/tag/2026.11.0
- Download: https://github.com/cloudflare/cloudflared/releases/download/2026.11.0/cloudflared-windows-amd64.exe
- SHA-256: `d5c1d82031da6253dcdcff64c944cd0fe063016edeb2e4fd088075fc9bd52d0a`
- Authenticode: Valid, signer `CN="Cloudflare, Inc."`

The binary is intentionally ignored by Git because it is large. To reinstall:

```powershell
Invoke-WebRequest `
  -Uri https://github.com/cloudflare/cloudflared/releases/download/2026.11.0/cloudflared-windows-amd64.exe `
  -OutFile bin\cloudflared.exe
Get-FileHash bin\cloudflared.exe -Algorithm SHA256
Get-AuthenticodeSignature bin\cloudflared.exe | Format-List Status,SignerCertificate
```

Expected hash must match the value above and the signature must be `Valid` before use.
