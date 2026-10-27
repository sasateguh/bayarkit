# toyyibPay API contract: official reference + what the sandbox actually did

Sources: **[API]** = https://toyyibpay.com/apireference/ (read in full 8 and 10 October 2026).
**[MEASURED]** = dev.toyyibpay.com sandbox, 10 October 2026, including one test-bank FPX payment
(bill `ne6jzusy`, 10:50 MYT). Where the two disagree, `@bayarkit/toyyibpay` and its fake follow [MEASURED].

## Endpoints

| Fact                                                                                                                                                                                                                                         | Source            |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| Hosts: production `https://toyyibpay.com`, sandbox `https://dev.toyyibpay.com`; API at `/index.php/api/<name>`                                                                                                                               | [API]             |
| Requests are form posts; `x-www-form-urlencoded` is accepted (the docs show multipart)                                                                                                                                                       | [API]; [MEASURED] |
| `createBill` → `[{"BillCode":"…"}]`; payment page = `<host>/<BillCode>`                                                                                                                                                                      | [API]             |
| `billAmount` in sen; `billName` ≤ 30, `billDescription` ≤ 100, letters/digits/space/`_` only                                                                                                                                                 | [API]             |
| `billPayorInfo=1` requires `billEmail` (empty email rejected); `=0` = open bill, and the bill page then asks for name, email and phone, all required                                                                                         | [API]; [MEASURED] |
| `billPaymentChannel`: `0` FPX, `1` card, `2` both                                                                                                                                                                                            | [API]             |
| `billChargeToCustomer`: blank = owner pays; `0` = FPX fee charged to the customer (not available for cards)                                                                                                                                  | [API]             |
| `billExternalReferenceNo` = your own reference; returned in transactions and as `order_id` in callbacks                                                                                                                                      | [API]             |
| `billExpiryDate` `dd-mm-yyyy HH:MM:SS`, read in **Malaysia time**                                                                                                                                                                            | [API]; [MEASURED] |
| Minimum amount: **100 sen accepted, 99 rejected** ("billAmount should more than RM1.00"; the bound is inclusive)                                                                                                                             | [MEASURED]        |
| `getBillTransactions` → list; `billpaymentStatus` 1 success · 2/4 pending · 3 failed; `billpaymentAmount` ringgit string `"10.00"`; send the owner's `userSecretKey`: the docs (23 Oct 2026) say payer/split/settlement/fee come back empty without it; MEASURED 27 Oct 2026, only `billTo`/`billEmail`/`billPhone` are empty and the fee stays; another account's key answers `No data found!`, the same as an unpaid bill; newest 5,000 only                                                                                                           | [API]; [MEASURED] |
| A bill with no transactions answers the **text `No data found!`**, not `[]`                                                                                                                                                                  | [MEASURED]        |
| Every response body starts with `\t\t\t\t` and is sent as `text/html`                                                                                                                                                                        | [MEASURED]        |
| Transaction = docs sample (incl. `billExternalReferenceNo`, `billpaymentInvoiceNo`) **+ `transactionCharge:"1.00"`, `chargeOn:"Amount"`**; `billStatus` becomes `"0"` after payment                                                          | [API]; [MEASURED] |
| `billPaymentDate` `dd-mm-yyyy HH:MM:SS` in Malaysia time; `billpaymentSettlementDate` is `yyyy-mm-dd HH:MM:SS` in the docs sample                                                                                                            | [API]; [MEASURED] |
| `getCategoryDetails`: docs `[{categoryName}]`, sandbox `{CategoryName}` (an object, capital C)                                                                                                                                               | [API]; [MEASURED] |
| `inactiveBill` takes `secretKey` (not `userSecretKey`): `{status:"success"}` · `{status:"failed",result:"Bill is inactive"}` · `{status:"error",result:"Invalid Secret Key!"}` — the last for a wrong key AND for a bill that does not exist | [API]; [MEASURED] |
| createBill errors come in two shapes: text `[KEY-DID-NOT-EXIST-OR-USER-IS-NOT-ACTIVE]` / `[CATEGORY-NOT-MATCH]`, and JSON `{"status":"error","msg":"billEmail parameter is empty"}`; a wrong key on `getCategoryDetails` gives an empty body | [MEASURED]        |

## Callback

| Fact                                                                                                                                                                             | Source            |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| Delivered as **`multipart/form-data`** with fields amount, billcode, fpx_transaction_id, hash, msg, order_id, reason, refno, status, status_id, transaction_id, transaction_time | [MEASURED]        |
| `hash = md5(userSecretKey + status + order_id + refno + "ok")`; the documented formula holds                                                                                     | [API]; [MEASURED] |
| `status` 1 success · 2 pending · 3 failed; `order_id` = `billExternalReferenceNo`                                                                                                | [API]             |
| The return URL receives `status_id`, `billcode`, `order_id` as query parameters                                                                                                  | [API]             |
