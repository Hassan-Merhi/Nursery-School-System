"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { withTransaction } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import {
  changePassword,
  hashPassword,
  requirePermission,
  requireUser,
  revokeCurrentSession,
} from "@/lib/security";

function value(formData: FormData, key: string) {
  return String(formData.get(key) ?? "").trim();
}

function fail(message: string): never {
  redirect(`/dashboard?error=${encodeURIComponent(message)}`);
}

function success(message: string): never {
  revalidatePath("/dashboard");
  redirect(`/dashboard?success=${encodeURIComponent(message)}`);
}

function uuidList(formData: FormData, key: string) {
  return formData
    .getAll(key)
    .map(String)
    .filter((item) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(item));
}

export async function logoutAction() {
  await revokeCurrentSession();
  redirect("/login");
}

export async function updateSchoolProfileAction(formData: FormData) {
  const auth = await requirePermission("school_profile.manage");
  const name = value(formData, "name");
  if (!name) fail("School name is required.");

  await withTransaction(async (client) => {
    const before = await client.query("select * from school_profile where id=1");
    const result = await client.query(
      `update school_profile
       set name=$1, legal_name=$2, email=$3, phone=$4, address=$5,
           timezone=$6, updated_at=now(), updated_by=$7
       where id=1 returning *`,
      [
        name,
        value(formData, "legal_name") || null,
        value(formData, "email") || null,
        value(formData, "phone") || null,
        value(formData, "address") || null,
        value(formData, "timezone") || "Asia/Beirut",
        auth.userId,
      ],
    );
    await writeAudit(client, {
      actorUserId: auth.userId,
      action: "school_profile_updated",
      entityType: "school_profile",
      entityId: "1",
      before: before.rows[0],
      after: result.rows[0],
    });
  });

  success("School profile updated.");
}

export async function createSchoolYearAction(formData: FormData) {
  const auth = await requirePermission("school_years.manage");
  const startYear = Number(value(formData, "start_year"));
  const status = value(formData, "status") || "planned";

  if (!Number.isInteger(startYear) || startYear < 2000 || startYear > 2100) {
    fail("Enter a valid school year start year.");
  }
  if (!["planned", "current"].includes(status)) fail("Invalid school year status.");

  const name = `${startYear}-${startYear + 1}`;
  await withTransaction(async (client) => {
    if (status === "current") {
      await client.query("update school_year set status='planned' where status='current'");
    }

    const inserted = await client.query<{ id: string }>(
      `insert into school_year(name, starts_on, ends_on, status, created_by)
       values ($1,$2,$3,$4,$5) returning id`,
      [
        name,
        `${startYear}-09-01`,
        `${startYear + 1}-06-30`,
        status,
        auth.userId,
      ],
    );
    const schoolYearId = inserted.rows[0].id;

    await client.query(
      `insert into school_term(school_year_id, sequence, name, starts_on, ends_on)
       values
         ($1,1,'September–December',$2,$3),
         ($1,2,'January–March',$4,$5),
         ($1,3,'April–June',$6,$7)`,
      [
        schoolYearId,
        `${startYear}-09-01`,
        `${startYear}-12-31`,
        `${startYear + 1}-01-01`,
        `${startYear + 1}-03-31`,
        `${startYear + 1}-04-01`,
        `${startYear + 1}-06-30`,
      ],
    );

    await writeAudit(client, {
      actorUserId: auth.userId,
      action: "school_year_created",
      entityType: "school_year",
      entityId: schoolYearId,
      after: { name, status, termTemplate: "Sep-Dec / Jan-Mar / Apr-Jun" },
    });
  });

  success(`School year ${name} created with all three terms.`);
}

export async function updateSchoolTermStatusAction(formData: FormData) {
  const auth = await requirePermission("school_years.manage");
  const termId = value(formData, "term_id");
  const status = value(formData, "status");

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(termId)) {
    fail("Invalid school term.");
  }
  if (!["open", "closed"].includes(status)) fail("Invalid term status.");

  let termName = "Term";
  await withTransaction(async (client) => {
    const before = await client.query<{
      id: string;
      name: string;
      status: string;
      year_status: string;
    }>(
      `select t.id,t.name,t.status,y.status as year_status
       from school_term t
       join school_year y on y.id=t.school_year_id
       where t.id=$1
       for update of t`,
      [termId],
    );
    const row = before.rows[0];
    if (!row) fail("School term not found.");
    if (status === "open" && row.year_status === "closed") {
      fail("Reopen the school year before reopening one of its terms.");
    }

    termName = row.name;
    await client.query("update school_term set status=$2 where id=$1", [termId, status]);
    await writeAudit(client, {
      actorUserId: auth.userId,
      action: status === "closed" ? "school_term_closed" : "school_term_reopened",
      entityType: "school_term",
      entityId: termId,
      before: row,
      after: { ...row, status },
    });
  });

  success(`${termName} ${status === "closed" ? "closed" : "reopened"}.`);
}

export async function createUserAction(formData: FormData) {
  const auth = await requirePermission("users.manage");
  const email = value(formData, "email").toLowerCase();
  const fullName = value(formData, "full_name");
  const password = String(formData.get("password") ?? "");
  const roleIds = uuidList(formData, "role_id");

  if (!email || !email.includes("@")) fail("Enter a valid email address.");
  if (!fullName) fail("Full name is required.");
  if (!roleIds.length) fail("Assign at least one role.");

  let passwordHash: string;
  try {
    passwordHash = await hashPassword(password);
  } catch (error) {
    fail(error instanceof Error ? error.message : "Invalid password.");
  }

  await withTransaction(async (client) => {
    const validRoles = await client.query<{ id: string }>(
      "select id from role where id = any($1::uuid[])",
      [roleIds],
    );
    if (validRoles.rowCount !== roleIds.length) fail("One or more roles are invalid.");

    const excessivePermissions = await client.query(
      `select distinct rp.permission_key
       from role_permission rp
       where rp.role_id = any($1::uuid[])
         and not (rp.permission_key = any($2::text[]))
       limit 1`,
      [roleIds, auth.permissions],
    );
    if (excessivePermissions.rowCount) {
      fail("You cannot assign a role that grants permissions you do not have.");
    }

    const inserted = await client.query<{ id: string }>(
      `insert into app_user(email, full_name, password_hash, created_by, updated_by)
       values ($1,$2,$3,$4,$4) returning id`,
      [email, fullName, passwordHash, auth.userId],
    );
    const userId = inserted.rows[0].id;

    for (const roleId of roleIds) {
      await client.query(
        `insert into user_role(user_id, role_id, assigned_by)
         values ($1,$2,$3)`,
        [userId, roleId, auth.userId],
      );
    }

    await writeAudit(client, {
      actorUserId: auth.userId,
      action: "user_created",
      entityType: "user",
      entityId: userId,
      after: { email, fullName, roleIds },
    });
  });

  success("User created.");
}

export async function updateUserAccessAction(formData: FormData) {
  const auth = await requirePermission("users.manage");
  const userId = value(formData, "user_id");
  const status = value(formData, "status");
  const roleIds = uuidList(formData, "role_id");

  if (!["active", "disabled"].includes(status)) fail("Invalid user status.");
  if (!roleIds.length) fail("A user must have at least one role.");
  if (userId === auth.userId && status === "disabled") {
    fail("You cannot disable your own account.");
  }

  await withTransaction(async (client) => {
    const before = await client.query(
      `select u.id,u.email,u.full_name,u.status,
         coalesce(array_agg(ur.role_id) filter (where ur.role_id is not null),'{}') role_ids
       from app_user u
       left join user_role ur on ur.user_id=u.id
       where u.id=$1 group by u.id`,
      [userId],
    );
    if (!before.rowCount) fail("User not found.");

    const validRoles = await client.query(
      "select id from role where id = any($1::uuid[])",
      [roleIds],
    );
    if (validRoles.rowCount !== roleIds.length) fail("One or more roles are invalid.");

    const excessivePermissions = await client.query(
      `select distinct rp.permission_key
       from role_permission rp
       where rp.role_id = any($1::uuid[])
         and not (rp.permission_key = any($2::text[]))
       limit 1`,
      [roleIds, auth.permissions],
    );
    if (excessivePermissions.rowCount) {
      fail("You cannot assign a role that grants permissions you do not have.");
    }

    const administratorRole = await client.query<{ id: string }>(
      "select id from role where lower(name)='administrator' limit 1",
    );
    const administratorRoleId = administratorRole.rows[0]?.id;
    const previousRoleIds = (before.rows[0].role_ids ?? []) as string[];
    const removingAdministrator =
      Boolean(administratorRoleId) &&
      previousRoleIds.includes(administratorRoleId) &&
      (status !== "active" || !roleIds.includes(administratorRoleId));

    if (removingAdministrator) {
      const anotherAdministrator = await client.query(
        `select 1
         from app_user u
         join user_role ur on ur.user_id=u.id
         join role r on r.id=ur.role_id
         where u.id<>$1 and u.status='active' and lower(r.name)='administrator'
         limit 1`,
        [userId],
      );
      if (!anotherAdministrator.rowCount) {
        fail("At least one active Administrator account must remain.");
      }
    }

    await client.query(
      "update app_user set status=$2, updated_at=now(), updated_by=$3 where id=$1",
      [userId, status, auth.userId],
    );
    await client.query("delete from user_role where user_id=$1", [userId]);
    for (const roleId of roleIds) {
      await client.query(
        "insert into user_role(user_id, role_id, assigned_by) values ($1,$2,$3)",
        [userId, roleId, auth.userId],
      );
    }
    if (status === "disabled") {
      await client.query(
        "update user_session set revoked_at=now() where user_id=$1 and revoked_at is null",
        [userId],
      );
    }

    await writeAudit(client, {
      actorUserId: auth.userId,
      action: "user_access_updated",
      entityType: "user",
      entityId: userId,
      before: before.rows[0],
      after: { status, roleIds },
    });
  });

  success("User access updated.");
}

export async function createRoleAction(formData: FormData) {
  const auth = await requirePermission("roles.manage");
  const name = value(formData, "name");
  const description = value(formData, "description") || null;
  const permissionKeys = formData.getAll("permission").map(String);

  if (!name) fail("Role name is required.");

  await withTransaction(async (client) => {
    const valid = await client.query<{ key: string }>(
      "select key from permission where key = any($1::text[])",
      [permissionKeys],
    );
    if (valid.rowCount !== permissionKeys.length) fail("Invalid permission selection.");
    const excessive = permissionKeys.filter((key) => !auth.permissions.includes(key));
    if (excessive.length) {
      fail("You cannot grant permissions that you do not have.");
    }

    const inserted = await client.query<{ id: string }>(
      "insert into role(name, description, created_by) values ($1,$2,$3) returning id",
      [name, description, auth.userId],
    );
    const roleId = inserted.rows[0].id;

    for (const key of permissionKeys) {
      await client.query(
        "insert into role_permission(role_id, permission_key) values ($1,$2)",
        [roleId, key],
      );
    }
    await writeAudit(client, {
      actorUserId: auth.userId,
      action: "role_created",
      entityType: "role",
      entityId: roleId,
      after: { name, description, permissionKeys },
    });
  });

  success("Role created.");
}

export async function updateRolePermissionsAction(formData: FormData) {
  const auth = await requirePermission("roles.manage");
  const roleId = value(formData, "role_id");
  const permissionKeys = formData.getAll("permission").map(String);

  await withTransaction(async (client) => {
    const role = await client.query<{ name: string; is_system: boolean }>(
      "select name,is_system from role where id=$1 for update",
      [roleId],
    );
    if (!role.rowCount) fail("Role not found.");
    if (role.rows[0].is_system) {
      fail("System role permissions are migration-controlled and cannot be weakened.");
    }

    const valid = await client.query(
      "select key from permission where key = any($1::text[])",
      [permissionKeys],
    );
    if (valid.rowCount !== permissionKeys.length) fail("Invalid permission selection.");
    const excessive = permissionKeys.filter((key) => !auth.permissions.includes(key));
    if (excessive.length) {
      fail("You cannot grant permissions that you do not have.");
    }

    const before = await client.query(
      "select permission_key from role_permission where role_id=$1 order by permission_key",
      [roleId],
    );
    await client.query("delete from role_permission where role_id=$1", [roleId]);
    for (const key of permissionKeys) {
      await client.query(
        "insert into role_permission(role_id, permission_key) values ($1,$2)",
        [roleId, key],
      );
    }

    await writeAudit(client, {
      actorUserId: auth.userId,
      action: "role_permissions_updated",
      entityType: "role",
      entityId: roleId,
      before: before.rows.map((row) => row.permission_key),
      after: permissionKeys,
    });
  });

  success("Role permissions updated.");
}

export async function updateSettingsAction(formData: FormData) {
  const auth = await requirePermission("settings.manage");
  const currency = value(formData, "currency").toUpperCase();
  const locale = value(formData, "number_locale");
  const receiptPrefix = value(formData, "receipt_prefix").toUpperCase();
  const invoicePrefix = value(formData, "invoice_prefix").toUpperCase();
  const rentalPrefix = value(formData, "rental_prefix").toUpperCase();

  if (!/^[A-Z]{3}$/.test(currency)) fail("Currency must be a 3-letter code.");
  if (!locale || locale.length > 40) fail("Enter a valid number locale.");
  for (const prefix of [receiptPrefix, invoicePrefix, rentalPrefix]) {
    if (!/^[A-Z0-9-]{2,10}$/.test(prefix)) {
      fail("Document prefixes must be 2-10 uppercase letters, numbers, or hyphens.");
    }
  }

  await withTransaction(async (client) => {
    const before = await client.query(
      `select key,value from app_setting where key in ('currency','number_locale')
       order by key`,
    );

    for (const [key, settingValue] of [
      ["currency", currency],
      ["number_locale", locale],
    ]) {
      await client.query(
        `insert into app_setting(key, category, value, updated_by)
         values ($1,'regional',$2::jsonb,$3)
         on conflict (key) do update set
           value=excluded.value, updated_at=now(), updated_by=excluded.updated_by`,
        [key, JSON.stringify(settingValue), auth.userId],
      );
    }

    for (const [type, prefix] of [
      ["receipt", receiptPrefix],
      ["invoice", invoicePrefix],
      ["rental", rentalPrefix],
    ]) {
      await client.query(
        `update document_sequence set prefix=$2, updated_at=now(), updated_by=$3
         where document_type=$1`,
        [type, prefix, auth.userId],
      );
    }

    await writeAudit(client, {
      actorUserId: auth.userId,
      action: "system_settings_updated",
      entityType: "settings",
      entityId: "core",
      before: before.rows,
      after: { currency, locale, receiptPrefix, invoicePrefix, rentalPrefix },
    });
  });

  success("System settings updated.");
}

export async function changePasswordAction(formData: FormData) {
  const auth = await requireUser();
  const currentPassword = String(formData.get("current_password") ?? "");
  const newPassword = String(formData.get("new_password") ?? "");
  const result = await changePassword(auth, currentPassword, newPassword);
  if (!result.ok) fail(result.message);
  success("Password changed. Other sessions were signed out.");
}
