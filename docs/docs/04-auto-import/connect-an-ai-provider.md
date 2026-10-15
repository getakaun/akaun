---
sidebar_position: 1
---

# Connect an AI provider

**Auto Import** uses an AI provider to read your documents. Add one provider before you upload
the first file. This page also tells what the processing options on the same tab do.

:::info

To add or change a provider, you need the **Manage** permission on **Settings**. Without it, the
**Intelligence** tab is read only. Akaun never shows the key of a provider.

:::

## What Akaun sends to the provider

:::caution

The provider is a service outside your server. Akaun sends it the text of each document that you
upload to **Auto Import**. Do not add a provider until you agree that it can read your receipts,
bills and statements.

:::

Akaun reads the text from each file on your own server first. For a photo or a scanned PDF, the
server uses text recognition (OCR). Then Akaun sends this text to the provider:

- the text of the document,
- the names of your expense and income categories,
- your **Custom instructions**, or the instructions of the import profile,
- for **Auto-detect**, the start of the document and the name and description of each enabled
  import profile.

Akaun does not send the file itself. The bank statements that you upload on the reconciliation
screen also go to the same provider. A spreadsheet that an import profile reads as **Table rows**
does not go to the provider. See [Import profiles](./import-profiles.md).

## The providers

| **Provider type** | What you need |
|---|---|
| **OpenRouter** | An API key from the OpenRouter website. One key gives access to many models. |
| **Google AI Studio** | An API key from the Google AI Studio website. It gives access to the Gemini models. |
| **Groq** | An API key from the Groq website. |
| **ChatGPT plan** | A paid ChatGPT plan. You sign in with a one-time code. You do not need an API key. |

The form shows a **Get a key ↗** link for each provider that uses an API key. The link opens the
page of that provider where you make a key.

## Add a provider with an API key

1. Click **Settings**.
2. Click the **Intelligence** tab.
3. Under **Providers**, click **Add provider**.
4. In **Provider type**, choose **OpenRouter**, **Google AI Studio** or **Groq**.
5. Click **Get a key ↗** and make a key on the website of the provider.
6. Paste the key into **API key**.
7. If you use OpenRouter and want no usage cost, click the **Free models only** switch.
8. Wait until Akaun loads the models. Then choose a model in **Model**.
9. If you want a different name for the provider, change **Name**.
10. Click **Add provider** at the bottom of the form.
11. Click **Save** at the bottom of the **Intelligence** tab.

The provider is not saved until you click **Save** in step 11.

## Add your ChatGPT plan

Before you start, enable device code sign-in in the security settings of your ChatGPT account.
If your ChatGPT account belongs to a workspace, ask the workspace administrator to do this.

1. Click **Settings**.
2. Click the **Intelligence** tab.
3. Under **Providers**, click **Add provider**.
4. In **Provider type**, choose **ChatGPT plan**.
5. Click **Sign in with ChatGPT**. Akaun opens the ChatGPT sign-in page in a new tab.
6. Under **Your one-time sign-in code**, click **Copy code**.
7. If no new tab opened, click **Open ChatGPT ↗**.
8. In ChatGPT, paste the code and approve the sign-in.
9. Return to Akaun. Wait until the form shows **Signed in**.
10. Choose a model in **Model**.
11. Click **Add provider** at the bottom of the form.
12. Click **Save** at the bottom of the **Intelligence** tab.

The code expires after a short time. The form shows the time of expiry. If the code expires, click
**Cancel** and start again from step 5.

## Result

The provider shows in the list under **Configured providers**. Its type, name and model show on
the row. **Auto Import** can now read documents.

## Use more than one provider

You can add more than one provider. Akaun tries the enabled providers in the order of the list.
If the first provider fails, Akaun tries the next one.

- To change the order, drag a provider by its handle on the left. Then click **Save**.
- To stop the use of a provider, click its switch. Then click **Save**.
- To change a saved provider, click its pencil icon. Make the change and click **Save changes**.
  This change is saved immediately.

:::caution

You cannot undo the deletion of a provider. To use it again, you must add it again with a new key
or a new sign-in.

:::

To delete a provider, click its pencil icon, then click **Delete**. Click **Delete** again to
confirm.

## Processing options

The **Processing** section is on the same tab. Click **Save** after you change an option.

| Option | What it does |
|---|---|
| **Parallel tasks** | The number of files that Akaun reads at the same time, from 1 to 10. |
| **Rate limit** | The time that Akaun waits between two calls to the provider, from 0 to 30 seconds. Use it if your provider has a limit on calls per minute. |
| **Category hints** | The switch is saved, but at this time it does not change how Akaun reads documents. |
| **Custom instructions** | Extra guidance for the AI, for example your usual suppliers and their categories. An import profile with its own instructions uses those in place of these. |

## Notes and limits

- If no provider is enabled, each file that needs AI fails with the message "No LLM providers
  configured".
- A ChatGPT provider that shows **Reconnect required** must sign in again. Click its pencil icon,
  then click **Sign in with ChatGPT**.
- The quality of the reading depends on the model. If many fields are wrong, try a different model.

## Related

- [Import receipts and documents](./import-receipts.md)
- [Import profiles](./import-profiles.md)
- [Settings reference](../09-administration/settings-reference.md)
