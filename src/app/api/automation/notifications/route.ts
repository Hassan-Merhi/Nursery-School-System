import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";

export const dynamic="force-dynamic";

function authorized(request:NextRequest){
  const secret=process.env.AUTOMATION_SECRET;
  if(!secret)return false;
  const header=request.headers.get("authorization");
  return header===`Bearer ${secret}`;
}

export async function POST(request:NextRequest){
  if(!process.env.AUTOMATION_SECRET){
    return NextResponse.json({ok:false,error:"Automation is not configured."},{status:503});
  }
  if(!authorized(request)){
    return NextResponse.json({ok:false,error:"Unauthorized."},{status:401});
  }

  const result=await query<{open_count:number;newly_detected:number;resolved_count:number}>(
    "select * from refresh_system_notifications(current_date,null)",
  );
  return NextResponse.json({ok:true,...(result.rows[0]??{open_count:0,newly_detected:0,resolved_count:0})});
}
