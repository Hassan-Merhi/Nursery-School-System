import pg from "pg";

const {Pool}=pg;
const databaseUrl=process.env.DATABASE_URL;
if(!databaseUrl){
  console.error("DATABASE_URL is required.");
  process.exit(1);
}

const dateArg=process.argv.find(x=>x.startsWith("--date="));
const asOf=dateArg?dateArg.slice("--date=".length):null;
if(asOf&&!/^\d{4}-\d{2}-\d{2}$/.test(asOf)){
  console.error("--date must use YYYY-MM-DD.");
  process.exit(1);
}

const pool=new Pool({connectionString:databaseUrl});
try{
  const result=await pool.query(
    "select * from refresh_system_notifications(coalesce($1::date,current_date),null)",
    [asOf],
  );
  console.log(JSON.stringify({ok:true,asOf:asOf??"current_date",...(result.rows[0]??{})},null,2));
}finally{
  await pool.end();
}
