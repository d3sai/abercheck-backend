export interface OrderPreviewResponse {
  order_number: string;
  base_number: string;
  client_name: string;
  amount_due: string;
  currency: string;
  status: string;
  manager_name: string;
  created_at: string;
  payments_count: number;
  payments_total: string;
  refunds_count: number;
  requisites_count: number;
  amount_changes_count: number;
  attachments_count: number;
  sibling_parts: { order_number: string; amount_due: string; status: string }[];
}

export interface DeleteResultResponse {
  order_number: string;
  payments_detached: number;
  payments_deleted: number;
  refunds_deleted: number;
  requisites_deleted: number;
  amount_changes_deleted: number;
  attachments_deleted: number;
}
