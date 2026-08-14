ALTER TABLE "shops" ADD COLUMN "payment_methods" payment_method[] DEFAULT '{mbank,card,cod}' NOT NULL;
