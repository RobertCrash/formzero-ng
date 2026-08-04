-- Migration number: 0006
-- Make the email transport and the envelope sender explicit.
--
-- Until now the only sender the schema stored was notification_email, which is
-- the SMTP username (typically the operator's own mailbox). The Cloudflare Email
-- Service requires a sender on a domain onboarded for sending, so the sender
-- becomes its own transport-independent field.

ALTER TABLE settings ADD COLUMN email_transport TEXT NOT NULL DEFAULT 'cloudflare';
ALTER TABLE settings ADD COLUMN email_from_address TEXT;
ALTER TABLE settings ADD COLUMN email_from_name TEXT;

-- Any row that already has an SMTP host was configured for SMTP. Keep its
-- behaviour, including its effective sender, instead of silently switching it to
-- a transport it has never been set up for.
UPDATE settings
SET
    email_transport = 'smtp',
    email_from_address = COALESCE(smtp_from_address, notification_email),
    email_from_name = smtp_from_name
WHERE smtp_host IS NOT NULL;
