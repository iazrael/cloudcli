/** 批量路径探测中的单项；id 用于结果对位，相对路径必须携带 projectId。 */
export type PathExistenceRequest = {
  id: string;
  path: string;
  projectId?: string;
};

/** 单条路径的探测结论；status 沿用 HTTP 语义：200 可读、404 不存在、403 超出可读范围、400 无法解析。 */
export type PathExistenceResult = {
  id: string;
  status: number;
};
