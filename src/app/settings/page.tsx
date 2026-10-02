import { query } from "@/lib/db";
import { requireUser } from "@/lib/security";
import {
  changePasswordAction,
  createRoleAction,
  createSchoolYearAction,
  createUserAction,
  logoutAction,
  updateRolePermissionsAction,
  updateSchoolProfileAction,
  updateSchoolTermStatusAction,
  updateSettingsAction,
  updateUserAccessAction,
} from "../dashboard/actions";

type RoleRow = {
  id: string;
  name: string;
  description: string | null;
  is_system: boolean;
  permissions: string[];
};

type UserRow = {
  id: string;
  email: string;
  full_name: string;
  status: string;
  last_login_at: Date | null;
  roles: { id: string; name: string }[];
};

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; success?: string }>;
}) {
  const auth = await requireUser();
  const { error, success } = await searchParams;
  const can = (permission: string) => auth.permissions.includes(permission);

  const canViewProfile = can("school_profile.view") || can("school_profile.manage");
  const canViewYears = can("school_years.view") || can("school_years.manage");
  const canViewRoles = can("roles.view") || can("roles.manage") || can("users.manage");
  const canViewPermissions = can("roles.view") || can("roles.manage");
  const canViewUsers = can("users.view") || can("users.manage");
  const canViewSettings = can("settings.view") || can("settings.manage");
  const canViewDocuments = can("documents.view");
  const canViewAudit = can("audit.view");

  const [
    profileResult,
    schoolYearsResult,
    rolesResult,
    permissionsResult,
    usersResult,
    settingsResult,
    sequencesResult,
    documentsResult,
    auditResult,
  ] = await Promise.all([
    canViewProfile
      ? query("select * from school_profile where id=1")
      : Promise.resolve({ rows: [] }),
    canViewYears
      ? query(
          `select y.id,y.name,y.starts_on,y.ends_on,y.status,
             coalesce(json_agg(
               json_build_object(
                 'id',t.id,'sequence',t.sequence,'name',t.name,'status',t.status,
                 'starts_on',t.starts_on,'ends_on',t.ends_on
               ) order by t.sequence
             ) filter (where t.id is not null),'[]') as terms
           from school_year y
           left join school_term t on t.school_year_id=y.id
           group by y.id
           order by y.starts_on desc`,
        )
      : Promise.resolve({ rows: [] }),
    canViewRoles
      ? query<RoleRow>(
          `select r.id,r.name,r.description,r.is_system,
             coalesce(array_agg(rp.permission_key order by rp.permission_key)
               filter (where rp.permission_key is not null),'{}') as permissions
           from role r
           left join role_permission rp on rp.role_id=r.id
           group by r.id
           order by r.is_system desc,r.name`,
        )
      : Promise.resolve({ rows: [] as RoleRow[] }),
    canViewPermissions
      ? query<{ key: string; description: string }>(
          "select key,description from permission order by key",
        )
      : Promise.resolve({ rows: [] as { key: string; description: string }[] }),
    canViewUsers
      ? query<UserRow>(
          `select u.id,u.email,u.full_name,u.status,u.last_login_at,
             coalesce(json_agg(
               json_build_object('id',r.id,'name',r.name) order by r.name
             ) filter (where r.id is not null),'[]') as roles
           from app_user u
           left join user_role ur on ur.user_id=u.id
           left join role r on r.id=ur.role_id
           group by u.id
           order by u.full_name,u.email`,
        )
      : Promise.resolve({ rows: [] as UserRow[] }),
    canViewSettings
      ? query<{ key: string; value: unknown }>(
          "select key,value from app_setting order by key",
        )
      : Promise.resolve({ rows: [] as { key: string; value: unknown }[] }),
    canViewSettings
      ? query<{ document_type: string; prefix: string; next_number: string }>(
          "select document_type,prefix,next_number from document_sequence order by document_type",
        )
      : Promise.resolve({
          rows: [] as { document_type: string; prefix: string; next_number: string }[],
        }),
    canViewDocuments
      ? query<{
          id: string;
          original_name: string;
          mime_type: string;
          size_bytes: string;
          uploaded_at: Date;
          uploaded_by_name: string | null;
        }>(
          `select d.id,d.original_name,d.mime_type,d.size_bytes,d.uploaded_at,
             u.full_name as uploaded_by_name
           from stored_document d
           left join app_user u on u.id=d.uploaded_by
           order by d.uploaded_at desc limit 30`,
        )
      : Promise.resolve({
          rows: [] as {
            id: string;
            original_name: string;
            mime_type: string;
            size_bytes: string;
            uploaded_at: Date;
            uploaded_by_name: string | null;
          }[],
        }),
    canViewAudit
      ? query<{
          id: string;
          occurred_at: Date;
          action: string;
          entity_type: string;
          entity_id: string | null;
          actor_name: string | null;
        }>(
          `select a.id,a.occurred_at,a.action,a.entity_type,a.entity_id,
             u.full_name as actor_name
           from audit_log a
           left join app_user u on u.id=a.actor_user_id
           order by a.occurred_at desc limit 50`,
        )
      : Promise.resolve({
          rows: [] as {
            id: string;
            occurred_at: Date;
            action: string;
            entity_type: string;
            entity_id: string | null;
            actor_name: string | null;
          }[],
        }),
  ]);

  const profile = profileResult.rows[0] ?? null;
  const schoolYears = schoolYearsResult.rows;
  const roles: RoleRow[] = rolesResult.rows;
  const permissions = permissionsResult.rows;
  const users: UserRow[] = usersResult.rows;
  const settings = settingsResult.rows;
  const setting = new Map(settings.map((row) => [row.key, row.value]));
  const sequences = sequencesResult.rows;
  const documents = documentsResult.rows;
  const auditRows = auditResult.rows;

  const prefix = (type: string) =>
    sequences.find((row) => row.document_type === type)?.prefix ?? "";

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Montikids Montessori Preschool & Nursery</p>
          <h1>Settings & Administration</h1>
          <p className="muted">
            Signed in as {auth.fullName} · {auth.roles.join(", ") || "No role"}
          </p>
        </div>
        <div className="top-actions">
          <form action={logoutAction}>
            <button className="secondary" type="submit">Sign out</button>
          </form>
        </div>
      </header>

      {error ? <div className="notice error">{error}</div> : null}
      {success ? <div className="notice success">{success}</div> : null}

      <section className="status-grid">
        <article className="panel">
          <p className="eyebrow">Security</p>
          <h2>{auth.permissions.length} permissions active</h2>
          <p className="muted">Server-side checks protect every privileged action.</p>
        </article>
        <article className="panel">
          <p className="eyebrow">Academic structure</p>
          <h2>3 fixed terms</h2>
          <p className="muted">Sep–Dec · Jan–Mar · Apr–Jun</p>
        </article>
        <article className="panel">
          <p className="eyebrow">Audit</p>
          <h2>Append-only events</h2>
          <p className="muted">Security and administration changes are recorded.</p>
        </article>
      </section>

      {profile ? (
        <section className="panel section-block">
          <div className="section-heading">
            <div>
              <p className="eyebrow">School</p>
              <h2>School profile</h2>
            </div>
            {!can("school_profile.manage") ? <span className="badge">Read only</span> : null}
          </div>
          <form action={updateSchoolProfileAction} className="form-grid">
            <label>
              School name
              <input name="name" defaultValue={String(profile.name ?? "")} disabled={!can("school_profile.manage")} required />
            </label>
            <label>
              Legal name
              <input name="legal_name" defaultValue={String(profile.legal_name ?? "")} disabled={!can("school_profile.manage")} />
            </label>
            <label>
              Email
              <input type="email" name="email" defaultValue={String(profile.email ?? "")} disabled={!can("school_profile.manage")} />
            </label>
            <label>
              Phone
              <input name="phone" defaultValue={String(profile.phone ?? "")} disabled={!can("school_profile.manage")} />
            </label>
            <label>
              Timezone
              <input name="timezone" defaultValue={String(profile.timezone ?? "Asia/Beirut")} disabled={!can("school_profile.manage")} />
            </label>
            <label className="span-2">
              Address
              <textarea name="address" defaultValue={String(profile.address ?? "")} disabled={!can("school_profile.manage")} />
            </label>
            {can("school_profile.manage") ? <button type="submit">Save school profile</button> : null}
          </form>
        </section>
      ) : null}

      {can("school_years.view") || can("school_years.manage") ? (
        <section className="panel section-block">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Academic calendar</p>
              <h2>School years & terms</h2>
            </div>
          </div>
          {can("school_years.manage") ? (
            <form action={createSchoolYearAction} className="inline-form">
              <label>
                Start year
                <input type="number" name="start_year" min="2000" max="2100" placeholder="2026" required />
              </label>
              <label>
                Status
                <select name="status" defaultValue="planned">
                  <option value="planned">Planned</option>
                  <option value="current">Current</option>
                </select>
              </label>
              <button type="submit">Create year + 3 terms</button>
            </form>
          ) : null}
          <div className="card-list">
            {schoolYears.map((year: any) => (
              <article className="subcard" key={year.id}>
                <div className="row-between">
                  <strong>{year.name}</strong>
                  <span className="badge">{year.status}</span>
                </div>
                <div className="term-grid">
                  {(year.terms as any[]).map((term) => (
                    <div key={term.sequence}>
                      <div className="row-between">
                        <strong>Term {term.sequence}</strong>
                        <span className="badge">{term.status}</span>
                      </div>
                      <span>{term.name}</span>
                      <small>{String(term.starts_on).slice(0, 10)} → {String(term.ends_on).slice(0, 10)}</small>
                      {can("school_years.manage") ? (
                        <form action={updateSchoolTermStatusAction} className="compact-form">
                          <input type="hidden" name="term_id" value={term.id} />
                          <button
                            type="submit"
                            name="status"
                            value={term.status === "closed" ? "open" : "closed"}
                            className="secondary"
                          >
                            {term.status === "closed" ? "Reopen term" : "Close term"}
                          </button>
                        </form>
                      ) : null}
                    </div>
                  ))}
                </div>
              </article>
            ))}
            {!schoolYears.length ? <p className="muted">No school years yet.</p> : null}
          </div>
        </section>
      ) : null}

      {can("users.view") || can("users.manage") ? (
        <section className="panel section-block">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Access</p>
              <h2>Users</h2>
            </div>
          </div>
          {can("users.manage") ? (
            <form action={createUserAction} className="form-grid create-box">
              <label>
                Full name
                <input name="full_name" required />
              </label>
              <label>
                Email
                <input type="email" name="email" required />
              </label>
              <label>
                Temporary password
                <input type="password" name="password" minLength={12} required />
                <small>12+ characters with uppercase, lowercase, and a number.</small>
              </label>
              <fieldset className="span-2">
                <legend>Roles</legend>
                <div className="check-grid">
                  {roles.map((role) => (
                    <label className="check" key={role.id}>
                      <input type="checkbox" name="role_id" value={role.id} />
                      {role.name}
                    </label>
                  ))}
                </div>
              </fieldset>
              <button type="submit">Create user</button>
            </form>
          ) : null}

          <div className="card-list">
            {users.map((user) => {
              const assigned = new Set((user.roles ?? []).map((role) => role.id));
              return (
                <article className="subcard" key={user.id}>
                  <div className="row-between">
                    <div>
                      <strong>{user.full_name}</strong>
                      <div className="muted">{user.email}</div>
                    </div>
                    <span className="badge">{user.status}</span>
                  </div>
                  <p className="muted">
                    Roles: {(user.roles ?? []).map((role) => role.name).join(", ") || "None"}
                  </p>
                  {can("users.manage") ? (
                    <form action={updateUserAccessAction} className="compact-form">
                      <input type="hidden" name="user_id" value={user.id} />
                      <label>
                        Status
                        <select name="status" defaultValue={user.status}>
                          <option value="active">Active</option>
                          <option value="disabled">Disabled</option>
                        </select>
                      </label>
                      <fieldset>
                        <legend>Roles</legend>
                        <div className="check-grid">
                          {roles.map((role) => (
                            <label className="check" key={role.id}>
                              <input
                                type="checkbox"
                                name="role_id"
                                value={role.id}
                                defaultChecked={assigned.has(role.id)}
                              />
                              {role.name}
                            </label>
                          ))}
                        </div>
                      </fieldset>
                      <button type="submit" className="secondary">Update access</button>
                    </form>
                  ) : null}
                </article>
              );
            })}
          </div>
        </section>
      ) : null}

      {can("roles.view") || can("roles.manage") ? (
        <section className="panel section-block">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Authorization</p>
              <h2>Roles & fine-grained permissions</h2>
            </div>
          </div>
          {can("roles.manage") ? (
            <form action={createRoleAction} className="form-grid create-box">
              <label>
                Role name
                <input name="name" required />
              </label>
              <label>
                Description
                <input name="description" />
              </label>
              <fieldset className="span-2">
                <legend>Permissions</legend>
                <div className="permission-grid">
                  {permissions.map((permission) => (
                    <label className="check permission-item" key={permission.key}>
                      <input type="checkbox" name="permission" value={permission.key} />
                      <span><strong>{permission.key}</strong><small>{permission.description}</small></span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <button type="submit">Create role</button>
            </form>
          ) : null}

          <div className="card-list">
            {roles.map((role) => {
              const activePermissions = new Set(role.permissions ?? []);
              return (
                <article className="subcard" key={role.id}>
                  <div className="row-between">
                    <div>
                      <strong>{role.name}</strong>
                      <div className="muted">{role.description}</div>
                    </div>
                    {role.is_system ? <span className="badge">System role</span> : null}
                  </div>
                  {can("roles.manage") && !role.is_system ? (
                    <form action={updateRolePermissionsAction} className="compact-form">
                      <input type="hidden" name="role_id" value={role.id} />
                      <div className="permission-grid">
                        {permissions.map((permission) => (
                          <label className="check permission-item" key={permission.key}>
                            <input
                              type="checkbox"
                              name="permission"
                              value={permission.key}
                              defaultChecked={activePermissions.has(permission.key)}
                            />
                            <span><strong>{permission.key}</strong><small>{permission.description}</small></span>
                          </label>
                        ))}
                      </div>
                      <button type="submit" className="secondary">Save permissions</button>
                    </form>
                  ) : (
                    <div className="chips">
                      {(role.permissions ?? []).map((permission) => (
                        <span className="chip" key={permission}>{permission}</span>
                      ))}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        </section>
      ) : null}

      {can("settings.view") || can("settings.manage") ? (
        <section className="panel section-block">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Configuration</p>
              <h2>Core settings & numbering</h2>
            </div>
          </div>
          <form action={updateSettingsAction} className="form-grid">
            <label>
              Currency
              <input name="currency" maxLength={3} defaultValue={String(setting.get("currency") ?? "USD")} disabled={!can("settings.manage")} />
            </label>
            <label>
              Number locale
              <input name="number_locale" defaultValue={String(setting.get("number_locale") ?? "en-US")} disabled={!can("settings.manage")} />
            </label>
            <label>
              Receipt prefix
              <input name="receipt_prefix" defaultValue={prefix("receipt")} disabled={!can("settings.manage")} />
            </label>
            <label>
              Invoice prefix
              <input name="invoice_prefix" defaultValue={prefix("invoice")} disabled={!can("settings.manage")} />
            </label>
            <label>
              Rental prefix
              <input name="rental_prefix" defaultValue={prefix("rental")} disabled={!can("settings.manage")} />
            </label>
            {can("settings.manage") ? <button type="submit">Save settings</button> : null}
          </form>
          <div className="muted">
            Backup policy: {JSON.stringify(setting.get("backup_strategy") ?? {})}
          </div>
        </section>
      ) : null}

      {can("documents.view") || can("documents.manage") ? (
        <section className="panel section-block">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Files</p>
              <h2>Document storage</h2>
            </div>
          </div>
          {can("documents.manage") ? (
            <form action="/api/documents" method="post" encType="multipart/form-data" className="inline-form">
              <label>
                Select document
                <input type="file" name="file" required />
              </label>
              <button type="submit">Upload document</button>
            </form>
          ) : null}
          <div className="table-wrap">
            <table>
              <thead><tr><th>File</th><th>Type</th><th>Size</th><th>Uploaded</th><th /></tr></thead>
              <tbody>
                {documents.map((document) => (
                  <tr key={document.id}>
                    <td>{document.original_name}</td>
                    <td>{document.mime_type}</td>
                    <td>{Math.ceil(Number(document.size_bytes) / 1024)} KB</td>
                    <td>{new Date(document.uploaded_at).toLocaleString("en-GB")}</td>
                    <td><a href={`/api/documents/${document.id}`}>Open</a></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <section className="panel section-block">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Account</p>
            <h2>Password security</h2>
          </div>
        </div>
        <form action={changePasswordAction} className="inline-form">
          <label>
            Current password
            <input type="password" name="current_password" autoComplete="current-password" required />
          </label>
          <label>
            New password
            <input type="password" name="new_password" autoComplete="new-password" minLength={12} required />
          </label>
          <button type="submit">Change password</button>
        </form>
      </section>

      {can("audit.view") ? (
        <section className="panel section-block">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Audit trail</p>
              <h2>Recent system events</h2>
            </div>
          </div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Entity</th></tr></thead>
              <tbody>
                {auditRows.map((row) => (
                  <tr key={row.id}>
                    <td>{new Date(row.occurred_at).toLocaleString("en-GB")}</td>
                    <td>{row.actor_name ?? "System / unknown"}</td>
                    <td><code>{row.action}</code></td>
                    <td>{row.entity_type}{row.entity_id ? ` · ${row.entity_id}` : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </main>
  );
}
