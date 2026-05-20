-- adds optional userid for order history tracking
ALTER TABLE "Order" ADD COLUMN "userId" TEXT;

-- speeds up user order history lookups
CREATE INDEX "Order_userId_createdAt_idx" ON "Order"("userId", "createdAt");