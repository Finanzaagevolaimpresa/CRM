'use server';
import { redirect } from 'next/navigation';
import { requirePermission } from './auth';
import { prisma } from './prisma';
import { attestPracticeMaterialsComplete, createPracticeReadiness, decidePracticeMaterial, formalizePractice, recordPracticeFunding, startPractice } from './practice-readiness';
async function run(form:FormData,fn:(db:typeof prisma,actor:Awaited<ReturnType<typeof requirePermission>>,raw:unknown)=>Promise<{id?:string;practiceId?:string}>){const actor=await requirePermission('service.write');const result=await fn(prisma,actor,Object.fromEntries(form.entries()));redirect(`/practice-readiness?updated=${result.id??result.practiceId}`);}
export async function createPracticeReadinessAction(form:FormData){return run(form,createPracticeReadiness);}
export async function formalizePracticeAction(form:FormData){return run(form,formalizePractice);}
export async function recordPracticeFundingAction(form:FormData){return run(form,recordPracticeFunding);}
export async function decidePracticeMaterialAction(form:FormData){return run(form,decidePracticeMaterial);}
export async function attestPracticeMaterialsCompleteAction(form:FormData){return run(form,attestPracticeMaterialsComplete);}
export async function startPracticeAction(form:FormData){return run(form,startPractice);}
