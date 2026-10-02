-- Phase 9 — practical role templates for permission-driven UI
-- Existing custom roles remain supported. These system roles provide safe defaults.

insert into role(name,description,is_system)
values
  ('Reception','Front-desk student, enrollment and parent-payment workflow.',true),
  ('Teacher','Classroom-focused student information without financial administration.',true),
  ('Accounting','Daily finance plus advanced accounting, banking, supplier and reporting controls.',true),
  ('Payroll Manager','Employee, salary advance and payroll workflow without general accounting administration.',true),
  ('Food Manager','Student food plans, packages, purchasing, inventory and stock posting.',true)
on conflict do nothing;

with desired(role_name,permission_key) as (
  values
    ('Reception','dashboard.view'),
    ('Reception','families.view'),
    ('Reception','families.manage'),
    ('Reception','students.view'),
    ('Reception','students.manage'),
    ('Reception','classes.view'),
    ('Reception','enrollments.view'),
    ('Reception','enrollments.manage'),
    ('Reception','student_documents.view'),
    ('Reception','student_documents.manage'),
    ('Reception','student_history.view'),
    ('Reception','billing.view'),
    ('Reception','payments.view'),
    ('Reception','payments.manage'),

    ('Teacher','dashboard.view'),
    ('Teacher','students.view'),
    ('Teacher','classes.view'),
    ('Teacher','enrollments.view'),
    ('Teacher','student_history.view'),

    ('Accounting','dashboard.view'),
    ('Accounting','billing.view'),
    ('Accounting','billing.manage'),
    ('Accounting','discounts.view'),
    ('Accounting','discounts.manage'),
    ('Accounting','discounts.approve'),
    ('Accounting','payments.view'),
    ('Accounting','payments.manage'),
    ('Accounting','accounting.view'),
    ('Accounting','accounting.manage'),
    ('Accounting','accounting.post'),
    ('Accounting','accounting.period_lock'),
    ('Accounting','accounting.mapping'),
    ('Accounting','expenses.view'),
    ('Accounting','expenses.manage'),
    ('Accounting','expenses.approve'),
    ('Accounting','expenses.post'),
    ('Accounting','suppliers.view'),
    ('Accounting','suppliers.manage'),
    ('Accounting','banking.view'),
    ('Accounting','banking.manage'),
    ('Accounting','banking.reconcile'),
    ('Accounting','recurring_expenses.view'),
    ('Accounting','recurring_expenses.manage'),
    ('Accounting','refunds.manage'),
    ('Accounting','rentals.view'),
    ('Accounting','rentals.manage'),
    ('Accounting','rentals.pay'),
    ('Accounting','rentals.post'),
    ('Accounting','food.view'),
    ('Accounting','inventory.view'),
    ('Accounting','management.view'),
    ('Accounting','reports.view'),
    ('Accounting','reports.export'),
    ('Accounting','analytics.view'),
    ('Accounting','payroll.view'),

    ('Payroll Manager','dashboard.view'),
    ('Payroll Manager','employees.view'),
    ('Payroll Manager','employees.manage'),
    ('Payroll Manager','payroll.view'),
    ('Payroll Manager','payroll.manage'),
    ('Payroll Manager','payroll.approve'),
    ('Payroll Manager','payroll.lock'),
    ('Payroll Manager','payroll.pay'),
    ('Payroll Manager','salary_advances.manage'),
    ('Payroll Manager','banking.view'),

    ('Food Manager','dashboard.view'),
    ('Food Manager','food.view'),
    ('Food Manager','food.manage'),
    ('Food Manager','food.billing'),
    ('Food Manager','food.payments'),
    ('Food Manager','inventory.view'),
    ('Food Manager','inventory.manage'),
    ('Food Manager','inventory.purchase'),
    ('Food Manager','inventory.post'),
    ('Food Manager','inventory.adjust'),
    ('Food Manager','suppliers.view')
)
insert into role_permission(role_id,permission_key)
select r.id,p.key
from desired d
join role r on lower(r.name)=lower(d.role_name)
join permission p on p.key=d.permission_key
on conflict do nothing;
