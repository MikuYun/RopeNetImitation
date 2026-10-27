import type { UserBrief, UserRole, UserStatus } from '@/types/domain'

/**
 * 当前登录用户 / 用户资料（ux2-contract §四）。
 *
 * `UserBrief` 上的 `uid` / `role` / `status` / `mutedUntil` 是**可选**的
 * （会话成员等精简投影可能不带）；真正代表「一个完整 User」的本类型把它们
 * 收紧为**必需**，这样个人中心/管理后台拿到的数据一旦缺字段就是类型错误，
 * 而不是运行时才 `undefined`。
 */
export interface User extends UserBrief {
  uid: number
  role: UserRole
  status: UserStatus
  mutedUntil: string | null
  bio?: string | null
  createdAt?: string
  online?: boolean
}
