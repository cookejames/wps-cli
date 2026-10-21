# Internal web API notes

Undocumented endpoints used by the Moneyhub-based web app. They may change at any
time. Hosts below are placeholders: `API` = config `apiBase`, `WEB` = config `webOrigin`.

## Auth

An httpOnly session cookie on the API host plus a `csrf-token` header. Every request sends:
`cookie`, `csrf-token`, `accept: application/json, text/plain, */*`, `accept-language`, a desktop Firefox `user-agent`
(or the session's `userAgent`), `origin` = `WEB` (mandatory: profile gives 403 and graphql 401 without it) and `referer` = `WEB/`. 401/403, or a body of `Invalid csrf` /
`No csrf found in headers`, means the session is invalid. The session expires
after a short sliding window (about 15 minutes).

## Endpoints

Responses are `{"data":{"result":[...],"meta":{}}}` unless noted.

1. `GET API/apiv2/profile` : 200 if the session is valid.
2. `GET API/apiV2/transactions?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD` : everything
   in range, no paging (`limit`/`offset` ignored; thousands of rows in one call).
   Fields: uid, userId, accountUid, amount (major units, negative = out),
   stringAmount, currency, date (ISO UTC), dateOnStatement, dateCreated,
   dateModified, description, cleanDescription, merchantName, notes, label,
   categoryId (numeric string for standard, UUID for custom), categoryIdConfirmed,
   categorisationSource, projectId?, status (posted|pending), deleted,
   counterpartyId, merchantCategoryCode, transactionInformation,
   enhancedCategories, providerStatus, sourceId.
3. `GET API/apiV2/customCategories` : `{uid, name, categoryGroup (number), custom?}`.
   Treat every item as custom (the flag is sometimes missing).
4. `GET API/apiv2/accounts` : uid, deleted, auto (true = provider sync, false = manual),
   dateCreated, accountName, providerAccountName, bankName, productName,
   type (cash|savings|card|investment|pension|mortgage|loan|properties|crypto|asset...),
   accountType, currency,
   currentBalance `{amount (major), date: YYYY-MM-DD, type?}`,
   balances `[{date, amount (major), type?, tag?}]` oldest to newest,
   providerLastUpdated (ISO; absent on manual accounts), lastTransactionDate,
   netWorthContribution, AER, closed (ISO datetime, or absent: the account was archived in the web app on that date; `closedReason` may accompany it). Sensitive and **not output by default**: parties,
   sortCodeAccountNumber, iban, providerAccountIdentifications.
   **`balances[]` history semantics.** Each item is `{date, amount, type?, tag?}`. An entry is recorded only when the
   value changes (cash/savings go back about three years with up to ~1,200 entries; investments, pensions and
   property start later). So the history is a step function: the balance on a day is the latest entry dated on or
   before it (`balanceForDate`, the web app's `getBalanceForDate`), and none before the first entry. Property and
   asset values are then grown from that entry's date as for today (see contract.md), which gives the right value
   for any past day. The `date`s are plain days; `type` is the entry type (e.g. an initial balance) and `tag` can be
   `initial`. Caveat: the history carries no settings, so a past day is computed with the account's *current*
   `netWorthEnabled`, contribution %, `yearlyAppreciation` and `closed` date, and deleted accounts are missing
   entirely; `raw_account_snapshots` records the settings as they were from the first sync onward.
   Manual balance edits (for a future `accounts set-balance`, not implemented): `PUT /apiv2/accounts/{uid}/balances`
   with `{amount, date[, tag]}` (the web app's `updateBalance` mutation).
5. `POST API/graphql` body `{query, variables}`; response `{"data":{...}}`, an `errors`
   array is a failure.

       query { genericProjects: projects(type: GenericProject) { id name __typename }
               propertyProjects: projects(type: PropertyProject) { id name __typename } }

   Either list may be `null`.
6. `GET API/text/resources?tenantId=<tenantId>&type=postlogin` : `data.categories[key]`
   = display name. There is no group-names section; group names are the title-cased
   public group key.
7. Standard category numeric IDs are not served by the API. The web bundle has
   objects like `{uid:12,key:"homeMaintenance",type:n.EXPENSE,categoryGroup:8,externalId:"<uuid>"}`;
   `wps dev extract-categories` extracts them. Numeric `categoryGroup` N corresponds to the
   public `group:N`.

## Public Moneyhub endpoints (unauthenticated)

- `GET https://api.moneyhub.co.uk/v2.0/standard-categories` : `{data:[{categoryId:"std:<uuid>",group:"group:N",key}]}`
- `GET https://api.moneyhub.co.uk/v2.0/standard-category-groups` : `{data:[{id:"group:N",key}]}`

## Mapping to the public Moneyhub Data API naming

| Internal | Normalised (public naming) |
|---|---|
| `uid` | `id` |
| `accountUid` | `accountId` |
| `amount` (major, number) | `amount.value` (integer minor units) + `amount.major` + `amount.currency` |
| `categoryId` `"12"` | `std:<externalId>` (+ `internalCategoryId`) |
| `categoryId` custom UUID | `cus:<uuid>` |
| `cleanDescription` | `shortDescription` |
| `description` | `longDescription` |
| `date` (UTC ISO) | `date` + `bookingDate` (local date in config timezone) |
| `notes`, `projectId`, `status`, `dateModified`, `merchantName`, `categoryIdConfirmed`, `counterpartyId`, `label` | same names |
| `deleted` | `deleted` (internal only; the public API uses webhooks) |
