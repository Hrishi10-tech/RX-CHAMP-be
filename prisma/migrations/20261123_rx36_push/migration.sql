-- =============================================================================
-- RX Vision 3.6: push notifications, server half.
--
-- Additive: two new tables, nothing existing changes. Safe while the 3.5 API runs.
-- Reverse (nothing else reads these tables):
--   DROP TABLE "push_outbox";
--   DROP TABLE "push_devices";
-- =============================================================================
SET LOCAL lock_timeout = '15s';

-- CreateTable
CREATE TABLE "push_devices" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "push_devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "push_outbox" (
    "id" UUID NOT NULL,
    "recipient_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "sent_state" TEXT NOT NULL DEFAULT 'NOT_SENT',
    "devices" INTEGER NOT NULL DEFAULT 0,
    "delivered" INTEGER NOT NULL DEFAULT 0,
    "error_code" TEXT,
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "push_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "push_devices_token_key" ON "push_devices"("token");

-- CreateIndex
CREATE INDEX "push_devices_user_id_idx" ON "push_devices"("user_id");

-- CreateIndex
CREATE INDEX "push_outbox_recipient_id_created_at_idx" ON "push_outbox"("recipient_id", "created_at");

-- CreateIndex
CREATE INDEX "push_outbox_sent_state_created_at_idx" ON "push_outbox"("sent_state", "created_at");
