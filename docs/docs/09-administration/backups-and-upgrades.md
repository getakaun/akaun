---
sidebar_position: 6
---

# Backups and upgrades

Use this page to keep a safe copy of your book, to restore it, and to install a new version of
Akaun. Make a backup on a regular schedule, and always before an upgrade.

:::info

Akaun has no backup, restore or reset button in the screens. The description of the
**Administrators** group mentions backups and reset, but these functions do not exist at this
time. You make a backup when you copy files on the server.

:::

## What to copy

Akaun keeps all the data of your book in two places. Copy both of them together.

- The database is the file at `DATABASE_PATH`. The default is `data/akaun.db` in the
  folder of the code. Two more files can be next to it: `akaun.db-wal` and `akaun.db-shm`. The
  three files are one database.
- The storage folder is the folder at `STORAGE_PATH`. The default is `data/storage`. It
  holds the receipts, attachments, statements and the company logo.

With Docker, both are in the `data` folder next to `docker-compose.yml`. Copy the full `data`
folder.

Also keep a copy of your settings file: `docker-compose.yml` for Docker, or `.env` for an
installation from the source code.

See [Where your data is](../01-getting-started/install.md#where-your-data-is).

## Make a backup

Stop Akaun before you copy the files. While Akaun runs, it can write to the database at any time.
The newest changes are often only in the `-wal` file. A copy of `akaun.db` alone can lose these
changes. A copy made during a write can also be damaged.

If you cannot stop Akaun, copy the three database files together, at a time when nobody uses
Akaun. A copy of a running database is not fully safe.

### With Docker

1. Go to the folder that contains `docker-compose.yml`.
2. Stop Akaun:

   ```sh
   docker compose stop
   ```

3. Copy the full `data` folder to a different disk or computer, for example:

   ```sh
   cp -a data /backup/akaun-2026-10-09
   ```

4. Start Akaun again:

   ```sh
   docker compose start
   ```

### With an installation from the source code

1. Stop the server. Use the service manager of your server, or press Ctrl+C in the terminal of
   `bun server.js`.
2. Copy the database file to a different disk or computer.
3. If `akaun.db-wal` and `akaun.db-shm` are next to the database file, copy them too.
4. Copy the storage folder.
5. From the folder of the code, start the server again with `bun server.js`.

### Result

The backup has the database file and the storage folder. Keep each backup with its date in the
name. Keep one or more backups on a different computer from the server.

:::tip

To test a backup, restore it on a different computer and open Akaun there. A backup that you did
not test can be incomplete.

:::

## Restore a backup

:::caution

A restore replaces all the data of the book with the backup. The changes that users made after
the backup are lost. Before you restore, copy the current data to a different folder.

:::

1. Stop Akaun.
2. Move the current database files and the storage folder to a different folder.
3. Copy the database file of the backup to the location of `DATABASE_PATH`.
4. If the backup has `-wal` and `-shm` files, copy them too.
5. Make sure that no `-wal` or `-shm` file from the current data stays next to the database.
6. Copy the storage folder of the backup to the location of `STORAGE_PATH`.
7. Start Akaun.
8. Sign in and do the ledger integrity check. See [Check the book](#check-the-book).

The book shows the data at the time of the backup. With Docker, Akaun makes the user `PUID` the
owner of the `data` folder each time it starts.

Restore a backup only into the version of Akaun that made it, or a newer version. An older version
cannot always read a database that a newer version changed.

## Install a new version

:::caution

Make a backup before each upgrade. A new version can change the database, and you cannot undo this
change from inside Akaun. Keep the backup until you check the book with the new version.

:::

### With Docker

1. Make a backup. See [Make a backup](#make-a-backup).
2. Go to the folder that contains `docker-compose.yml`.
3. Get the new version:

   ```sh
   docker compose pull
   ```

4. Start the new version:

   ```sh
   docker compose up -d
   ```

### With an installation from the source code

1. Make a backup. See [Make a backup](#make-a-backup).
2. Make sure that the server is stopped.
3. In the folder of the code, get the new code:

   ```sh
   git pull
   ```

4. Install the packages:

   ```sh
   bun install
   ```

5. Build the application:

   ```sh
   bun run build
   ```

6. Start the server:

   ```sh
   bun server.js
   ```

## What happens at the first start

A new version updates the database by itself when it starts for the first time. You do not type a
command. Usually Akaun changes the database in place and keeps no copy. This is why your own backup
is necessary.

A book from an older version, from before the standard chart of accounts, needs a larger
conversion. Akaun does this conversion on a copy of the database first:

- If all the checks pass, Akaun puts the converted copy in place. It moves the previous files into
  a new folder next to the database. The name of the folder is `pre-chart-` with the date and time,
  for example `data/pre-chart-2026-10-09T08-15-30.123Z`. The folder holds `akaun.db`, and
  `akaun.db-wal` and `akaun.db-shm` if they existed.
- If a check fails, Akaun does not start. The server shows **This installation's books could not
  be converted, so the server has not started. Your database has not been changed.** and the
  reason.

Akaun does not use the `pre-chart-` folder again. After you check the book, you can move the
folder to your backup storage.

If the book is very old, Akaun does not start. The server tells you which version to install
first. Install that version, start it one time, and then install the new version. Akaun does not
change your database in this case.

## Check the book

Do this check after each upgrade and after each restore.

:::info

You need the **View** permission on **Reports** to see the **Ledger** tab. A superuser can see it.

:::

1. In the sidebar, click **Settings**.
2. Click the **Ledger** tab.
3. Under **Ledger integrity check**, click **Check now**.
4. If the tab shows **Migration results**, read each part of it.
5. Open the **Reports** screen and compare the main figures with the figures before the upgrade.

If all records balance, Akaun shows **The ledger is in balance. All records and the trial balance agree.** See
[Settings reference](./settings-reference.md#ledger).

If **Migration results** says that nothing old was thrown away, the copy of your data from before
the upgrade is in the `pre-chart-` folder next to the database.

If a figure is wrong, do these steps:

1. Stop Akaun.
2. Restore the backup that you made before the upgrade.
3. Install the previous version again.
4. Report the problem. See [Troubleshooting](../10-help/troubleshooting.md).

## Notes and limits

- A backup copy holds all your financial data and the API keys of your AI providers. Keep it in a
  safe place.
- Akaun does not make backups on a schedule. Use the tools of your server, for example a cron job,
  to stop Akaun, copy the files and start Akaun again.
