export const SMS_PACKAGES_COLLECTION = "sms_packages";

export type SmsPackageSnapshot = {
  id: string;
  name: string;
  price: number;
  priceLabel: string;
  messageQuota: number;
  plan_key?: string | null;
};

export type SmsPackage = SmsPackageSnapshot & {
  description?: string;
  features: string[];
  active: boolean;
  hidden: boolean;
  popular?: boolean;
  color?: string;
  icon?: string;
  stripePriceId?: string | null;
  stripeProductId?: string | null;
  createdAt?: Date | null;
  updatedAt?: Date | null;
};

export type CreateSmsPackageInput = {
  name: string;
  price: number;
  priceLabel: string;
  messageQuota: number;
  description?: string;
  features?: string[];
  active?: boolean;
  hidden?: boolean;
  popular?: boolean;
  color?: string;
  icon?: string;
  plan_key?: string;
};

export type UpdateSmsPackageInput = Partial<CreateSmsPackageInput> & { id: string };
