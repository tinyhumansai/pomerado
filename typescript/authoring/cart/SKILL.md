---
name: cart
description: Read before building any tool that reads, adds to, changes or checks out a cart: when to sign in or check out as a guest, read the cart before and after, quantity, account values and site limits.
---

# Carts and checkout

Read this for any tool that reads, adds to, changes or checks out a cart. For a write, the
writes skill's session, commit and publication rules still apply; this adds what a cart needs.

## Sign in, or check out as a guest

A cart a later call must find, such as a standalone add-to-cart, view-cart, change-cart or
checkout tool's, runs on the caller's account, because a signed-out cart lives in one browser
session. Sign in before reading or changing it (for a write, before the first `act` step; the
auth skill), even when the site lets a guest add to a cart, and judge the account's cart only
from the account.

A tool that fills the cart and places the order in the same run may use the site's guest
checkout when the site offers one and the build holds no login. Prefer it to creating an
account. Decide before you sign in, since a build that sent a login keeps it. Take the guest's
contact details as inputs and the card as the caller-input skill says.

## Take the product as the site's tools do

Take the product as the identifier and option values the site's own pages use, such as a
product number and a size, so a caller can pass a search or details tool's output straight in.
When `reference/site-tools.json` lists such a tool, use its identifier, field names and option
values (the core skill). Quantity, each option the product offers and, when the site lets a
visitor set one, the location or store are inputs. Set the options as "Configure, then read" in
the core skill says before adding the product: a value the product does not offer throws
`InvalidInput` with `field` and `available`.

## Quantity

The request decides whether quantity adds that many to the cart or sets the line to that
number; ask when it does not settle which. Build only that one, and state it in the tool's
description and the quantity field's description, such as "Units to add; an existing line grows
by this many".

Set a line's quantity with the site's own stepper through the SDK's `setQuantity`: import
`quantityCode` from the runtime, paste it after `waitCode`, and call `setQuantity({ count,
increase, decrease, add }, quantity, { overlays, limit })` with the verified locators of the line's
count, its `+` and `−` controls, the control that adds the first one, such as ADD, and the loader
the site draws over the stepper as `overlays`. It presses one step at a time and reads the count
back after each, since many sites drop a press made under their loader or post each press as its
own cart write, so presses sent together get lost or add too many. Each press is a cart write:
enter the commit mark before the call, as the writes skill says. For a quantity that adds, pass the
count read before the write plus the input. It returns `{ set: true, quantity, presses }`, or `{
set: false, reason: "limit", quantity, presses }` when the site takes no more, or no fewer, its
next control greyed out, its own `limit` sign showing or a step it showed and then took back:
return the site's limit as the tool's answer, the line as it stands, with the quantity asked and
the one kept in `saved_differences`. After its last press it waits for the page to show no progress
for 2 s, so a site that saves the count a while after the last press, and then caps or reverts it,
has answered first: a count the site takes back, as far as the count the line started from, comes
back as the site's limit at that count. A page not yet quiet at the deadline, or a save still in
flight then, fails as `unanswered`, since the write's outcome isn't known; on a page that never
goes quiet it stops waiting after 15 s, once the requests then in flight end. Leave the call's
deadline room for that wait. Decode its result with `QuantityOutcome`. A press that leaves the
count as it was, moves it by more than one or gets no settled answer by the deadline (`unanswered`)
fails as a `QuantityFailure` with the count read: read the cart again before anything else, since a
press may have landed. It throws `too_many_steps` when the count is, or the page moves it, more
than `maxSteps` (20) away, which can follow a press. A quantity typed into the site's own quantity
box and read back needs no stepper. Never press a stepper with clicks of your own: publication
review sends one back ("Own stepper"). `references/cart-stepper.ts` sets a line's quantity and
lists the site's limit in `saved_differences`; it shows the stepper alone, so a cart tool built on
it still reads the cart's lines before and after its write ("Read the cart before and after").

## Read amounts

Read money from the page with the SDK's `readAmount` and `readAmounts`: import `amountCode` from
the runtime and paste it after `visibleTextCode`. `readAmounts(rows, { label, amount }, { currency
})` reads a bill's or a cart's lines in one call, each as `{ label, amount, struck, text }`, with
`label` and `amount` as CSS selectors inside each row, and `readAmount(locator, { currency })` one
element, such as a total or the amount an order button names. `amount` is `{ minor, currency, free
}`, in minor units as the core skill gives money, and signed: an amount the page shows with a
minus, or in brackets around an amount showing its currency, such as (₹20), is negative, as a
wallet deduction often is, and an unsigned one, a bare bracketed number included, is positive, so
tell a deduction the page shows unsigned by its line's own label; a line the site shows as FREE is
zero with `free`; a free gift's zero line is zero; and an amount struck out beside the live one,
such as an old price or a waived fee, comes back in `struck`, never as the amount. Pass as
`currency` the currency the page prices in, for a bare number, a symbol several currencies share,
or a currency code that is also an English word, such as ALL or TOP, which names a currency only
when it is that `currency`. A deduction may show as a minus, a dash and a space ("- 20,00 €"), or
brackets, and comes back negative. Name the element that holds one amount: text with two numbers,
such as a count beside a price, is no amount (null). `parseAmount(text, { currency })` reads text
the tool already holds the same way. Decode `readAmount`'s result with `AmountRead` and
`readAmounts`' with `AmountLines`. Return every line the page shows, fees, tips, donations, wallets
and zero-priced gifts included, as data, and leave none out or fold it into another. Publication
review sends back an amount read with a pattern or `parseFloat` of the tool's own ("Own amount
parsing"). `references/bill-lines.ts` reads a bill's lines and its total.

## Read the cart before and after

Read the cart's lines before the write, in the session and in the composed script; never
assume the cart starts empty. Afterwards, confirm from the cart itself that the line reached
the expected quantity (the earlier quantity plus the input, or the input) and that every other
line is unchanged, then return the lines as read and call `verified()`. When comparing lines
before and after, such as to list other lines that changed, prefer comparing
`unit_price_minor` with `unit_price_minor` and `line_total_minor` with `line_total_minor` (core
skill, output fields), so a line's quantity, new or above one, doesn't read as a price change.
After the tool's final commit, a line that changed to another quantity than expected, such as
one the site capped, is still the written line: call `verified()` and list it in
`saved_differences` (writes skill). A checkout reads the lines it is about to buy before its
commit and returns them with the confirmation.

## Values the account lacks

A value the flow needs that the account lacks, such as a delivery address, is a question for
the caller: ask with `request_input` while building, and in the tool take it as an input or a
declared question (the caller-input skill). Never invent it, and never save it to the account
unasked. A save option the page pre-selects is a question, as `AGENTS.md` says; in the
tool, an unset save option means off, not the page's default.

Choosing the delivery address and payment method is part of a checkout's job, even when the
account has saved ones the page pre-selects: take each from the input, such as which saved
address or a new one, or ask before the commit mark which to use (the writes skill). Never use
the page's selection silently. A paid add-on within the tool's purpose, such as a protection
plan for the item bought, is an input or a question too. A paid membership, subscription or
trial the checkout offers is outside its purpose: decline it without asking, never accept it
without an input the caller set, and handle its pop-up as conditional (the forms skill), since
it shows only to some accounts.

Choose the way to pay with `chooseOne` (the forms skill) on the way's own control, inside the
payment frame through `frameLocator` when the site shows its ways to pay in one, and read which
way is chosen with `readChoices` just before the commit, so the commit reports the way the page
shows chosen. A way the page greys out or says is not available comes back unavailable with its
words: return that as the site's answer, never pick another way unasked.

When the site shows a payment QR code, return the payment it holds as text, never a picture of
the page: read it with the SDK's `readQrCode(locator)`, after importing `qrCodeCode` from the
runtime and pasting it, on the element that holds the code alone, an image, a canvas or an SVG,
inside a frame through `frameLocator` too. It returns the code's text, such as a `upi://pay` link,
and fails as `no_code` when the element shows no code it can read. When the page holds that link
itself, such as in a link's `href`, prefer reading it there. Wait for the code to show first, and
press a control that reveals it with a real click. `references/payment-qr.ts` reads the link a
payment QR code holds and checks its amount against the order's.

## Minimums and refusals

When the site refuses the order as asked, such as an order under its minimum or an empty cart
at checkout, the tool throws `new errors.InvalidInput(message, { field })` with the site's
reason, `field` the input the caller would change, before its commit mark whenever the page shows
the limit first. A checkout that takes a limit of the caller's, such as
a maximum total, reads the final total and compares it before the order's commit mark, and
refuses with `InvalidInput`, `field` that input and `kind: "over_price_limit"`, giving the total
and the limit (the caller-input skill). Never add items, raise a quantity or change the
delivery method to meet a limit. While building, ask the caller to revise or stop, as
`AGENTS.md` says. When they stop, or their answer cannot be met either, end with
`report_blocked` and explain the site's limit: a build that only reached the limit never
completed the write, so it never publishes.

## Description

The description states the decisions a caller needs to use the tool right (the publication
skill): that it acts on the signed-in account's cart or checks out as a guest, whether
quantity adds or sets, what it returns, and what it leaves out, such as placing the order.
