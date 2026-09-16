# Windows code signing with Azure Artifact Signing

Maiden Media Solutions INC. — step-by-step setup. Written 2026-09-16.

Windows 11's Smart App Control refuses to run any program that is not signed
by a verified publisher, and SmartScreen warns on unsigned installers. Azure
Artifact Signing (Microsoft renamed it from "Trusted Signing" in 2026) issues
a certificate to the verified legal entity and signs each build from GitHub
Actions. Nothing has to be downloaded or kept safe locally. Cost: $9.99 per
month for the Basic tier, 5,000 signatures included.

The build workflow is already wired for it. Once the six secrets in Part 5
exist, the next `v*` tag produces a signed installer and the release goes out.

---

## Part 1 — Azure account (10 minutes)

1. Go to https://portal.azure.com and sign in with a Microsoft account for
   the company. Create one if needed.
2. If you have no Azure subscription yet, search **Subscriptions** → **Add**,
   and create a Pay-As-You-Go subscription. It needs a card, and the only
   charge will be the $9.99/month Artifact Signing account.
3. Register the resource provider once:
   **Subscriptions** → your subscription → **Settings** → **Resource providers**
   → find `Microsoft.CodeSigning` → **…** → **Register**. Wait until it says
   Registered.

## Part 2 — Artifact Signing account (5 minutes)

1. In the portal search box type **Artifact Signing Accounts** and open it.
2. **Create**.
   - Subscription: yours.
   - Resource group: **Create new**, name it `maidenplayer-signing`.
   - Account name: `maidenmedia` (3–24 letters and digits, globally unique;
     try `maidenmediasolutions` if taken). **Write this down — it becomes
     the secret `AZURE_SIGN_ACCOUNT`.**
   - Region: **East US**. Its endpoint is `https://eus.codesigning.azure.net`.
     **Write this down — it becomes `AZURE_SIGN_ENDPOINT`.** (If you pick
     another region, use its endpoint from the table at the end.)
   - Pricing: **Basic**.
3. **Review + create** → **Create** → **Go to resource**.

## Part 3 — Identity validation (the slow part: 1 to 20 business days)

This is Microsoft verifying that Maiden Media Solutions INC. is a real
company. Have the business registration document and the company website
ready. Microsoft has required a verifiable history of about three years for
public-trust validation; keep public records (state registration, D-U-N-S,
website WHOIS) current before you start.

1. First give yourself the role that allows it: in the account, open
   **Access Control (IAM)** → **Add** → **Add role assignment** → search
   **Artifact Signing Identity Verifier** → **Next** → **Select members** →
   pick yourself → **Review + assign**. (You also need at least Reader on the
   subscription, which an owner has.)
2. Back in the account, under **Objects** open **Identity validations**.
3. Select **Organization**, then **New Identity**, then **Public**.
4. Fill in the form. Use the legal name exactly as registered:
   - Organization Name: `Maiden Media Solutions INC.` — this text becomes the
     certificate's subject and must match `build.win.publisherName` in
     `package.json` exactly. If the public record spells it differently
     (for example `Inc.`), enter it as registered and tell the developer so
     `package.json` is updated to match.
   - Website URL: the company site.
   - Primary and Secondary Email: two different monitored mailboxes on the
     company domain. Verification links arrive here and expire in seven days.
   - Business Identifier: the state registration / entity number (or D-U-N-S).
   - Address: the registered business address.
   - First / Last Name: yours, exactly as on your government ID. You will
     verify your own identity as the company's representative.
5. Check **Certificate subject preview**, then **Create**. Status becomes
   **In Progress**.
6. Watch the primary mailbox. When the status turns **Action Required**, open
   the request, follow the "complete your verification" link, and go through
   the ID check (AU10TIX): email PIN, phone number, scan the QR code with your
   phone, photograph your government ID, then add the Verified ID to the
   Microsoft Authenticator app when prompted. Have Authenticator installed on
   your phone first.
7. If Microsoft asks for documents, upload them in the portal on the request
   (three attempts; documents issued within the last 12 months).
8. Done when the status reads **Completed**. You get an email either way.

## Part 4 — Certificate profile (2 minutes, after Part 3 completes)

1. In the account, under **Objects** open **Certificate profiles** → **Create**
   → **Public Trust**.
2. Certificate Profile Name: `maidenplayer`. **Write this down — it becomes
   `AZURE_SIGN_PROFILE`.**
3. Verified CN and O: select the completed identity validation. Leave street
   address and postal code unchecked.
4. **Create**.

## Part 5 — Let GitHub Actions sign (15 minutes)

The build needs an identity of its own — an "app registration" — with
permission to sign, and its three IDs go into GitHub as secrets.

**A. Create the app registration**

1. Portal search: **Microsoft Entra ID** → **App registrations** →
   **New registration**.
2. Name: `maidenplayer-github-signing`. Leave the rest default → **Register**.
3. On its Overview page copy two values:
   - **Application (client) ID** → secret `AZURE_CLIENT_ID`
   - **Directory (tenant) ID** → secret `AZURE_TENANT_ID`
4. **Certificates & secrets** → **Client secrets** → **New client secret**.
   Description `github`, expiry **24 months** → **Add**. Copy the **Value**
   column immediately (it is shown once) → secret `AZURE_CLIENT_SECRET`.
   Put a reminder in the calendar to rotate it before it expires.

**B. Allow it to sign**

1. Go back to the Artifact Signing account → **Access Control (IAM)** →
   **Add** → **Add role assignment**.
2. Search **Artifact Signing Certificate Profile Signer** → **Next**.
3. Assign access to **User, group, or service principal** → **Select
   members** → search `maidenplayer-github-signing` → select → **Review +
   assign**.

**C. Add the six secrets to GitHub**

https://github.com/Maidendev/pokit-player/settings/secrets/actions →
**New repository secret**, one at a time:

| Secret | Value | From |
|---|---|---|
| `AZURE_TENANT_ID` | Directory (tenant) ID | Part 5A |
| `AZURE_CLIENT_ID` | Application (client) ID | Part 5A |
| `AZURE_CLIENT_SECRET` | the client secret Value | Part 5A |
| `AZURE_SIGN_ENDPOINT` | `https://eus.codesigning.azure.net` | Part 2 |
| `AZURE_SIGN_ACCOUNT` | the account name | Part 2 |
| `AZURE_SIGN_PROFILE` | `maidenplayer` | Part 4 |

## Part 6 — Release

Tag the next version and push it:

```
git tag v1.5.3 && git push origin v1.5.3
```

The Windows job prints "Windows code signing: ENABLED (Azure Trusted
Signing)", signs the installer and the app, checks the signature, and the
publish job makes the release public. The installed apps then verify each
downloaded update against the publisher name before running it.

If the job fails with a signing error, the usual causes are: the secret
Value was copied from the wrong column (Secret ID instead of Value); the
role assignment in Part 5B is missing; or the identity validation is not yet
**Completed**.

---

### Regional endpoints

| Region | Endpoint |
|---|---|
| East US | `https://eus.codesigning.azure.net` |
| West US 2 | `https://wus2.codesigning.azure.net` |
| West Central US | `https://wcus.codesigning.azure.net` |
| Central US | `https://cus.codesigning.azure.net` |
| West Europe | `https://weu.codesigning.azure.net` |
| North Europe | `https://neu.codesigning.azure.net` |

Full list: https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart

### Sources

- https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart
- https://learn.microsoft.com/en-us/azure/artifact-signing/tutorial-assign-roles
- https://azure.microsoft.com/en-us/products/artifact-signing
