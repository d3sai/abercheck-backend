-- Payment details of an order paid to other requisites, kept apart from the short comment.
ALTER TABLE "orders" ADD COLUMN "requisites" TEXT;
