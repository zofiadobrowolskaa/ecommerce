-- additive migration: introduces totalAmount column required by checkout
-- safe to run on existing database because DEFAULT keeps previous rows valid
ALTER TABLE "Order" ADD COLUMN "totalAmount" DECIMAL(10,2) NOT NULL DEFAULT 0;

-- performance index for reporting and status filtering
CREATE INDEX "Order_status_idx" ON "Order"("status");
