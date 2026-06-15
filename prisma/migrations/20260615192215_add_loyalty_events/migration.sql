-- CreateTable
CREATE TABLE "LoyaltyEvent" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shop" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "email" TEXT,
    "type" TEXT NOT NULL,
    "points" REAL NOT NULL,
    "orderId" TEXT,
    "couponCode" TEXT,
    "couponValue" REAL,
    "expiresAt" DATETIME,
    "couponUsed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "LoyaltyEvent_shop_type_idx" ON "LoyaltyEvent"("shop", "type");

-- CreateIndex
CREATE INDEX "LoyaltyEvent_shop_createdAt_idx" ON "LoyaltyEvent"("shop", "createdAt");
