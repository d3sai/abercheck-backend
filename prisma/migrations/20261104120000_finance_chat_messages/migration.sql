-- CreateTable
CREATE TABLE "finance_chat_messages" (
    "chat_id" BIGINT NOT NULL,
    "message_id" INTEGER NOT NULL,
    "request_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "finance_chat_messages_pkey" PRIMARY KEY ("chat_id","message_id")
);
