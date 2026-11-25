"""Two real independent PostgreSQL sessions, using only a disposable CI service."""
import os
import re
import subprocess
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CONTAINER = os.environ["PF_TEST_POSTGRES_CONTAINER"]
def command(app):
    return ["docker", "exec", "-i", "-e", "PGAPPNAME="+app, CONTAINER,
            "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "referral_test"]
def run(sql, app="pf_check"):
    return subprocess.run(command(app), input=sql, text=True, capture_output=True,
                          timeout=20, check=True).stdout.strip()
def session(app):
    return subprocess.Popen(command(app), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, text=True, bufsize=1)
def send(proc, sql):
    proc.stdin.write(sql+"\n")
    proc.stdin.flush()
def read(proc):
    line=proc.stdout.readline()
    if not line:
        raise AssertionError("Database session ended unexpectedly")
    return line.strip()
def finish(proc):
    send(proc, "COMMIT;\n\\q")
    proc.wait(timeout=10)
    assert proc.returncode == 0
def fail_cleanup(proc):
    if proc.poll() is None:
        proc.kill()
        proc.wait(timeout=5)
def actor(client):
    return "SET statement_timeout='12s'; SET ROLE authenticated; SET pf.test_client='"+client+"';"
def main():
    run((ROOT/"scripts/qa/referral-concurrency-fixture.sql").read_text())
    run((ROOT/"supabase/proposals/referral_concurrency_hardening.sql").read_text())
    assert run("SET ROLE authenticated; SELECT public.my_referral_code() IS NULL;")=="t"
    a=session("pf_code_a")
    b=None
    try:
        send(a, actor("synthetic-client")+" BEGIN; SELECT public.my_referral_code();")
        code=read(a)
        assert re.fullmatch(r"[0-9a-f]{8}",code),code
        b=session("pf_code_b")
        send(b,actor("synthetic-client")+" SELECT public.my_referral_code();")
        deadline=time.monotonic()+5
        while time.monotonic()<deadline:
            if run("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='pf_code_b' AND wait_event_type='Lock');")=="t":
                break
            time.sleep(0.05)
        else:
            raise AssertionError("Second generation did not contend on the unique key")
        finish(a)
        assert read(b)==code
        send(b,"\\q")
        b.wait(timeout=10)
        assert b.returncode==0
        assert run("SELECT count(*) FROM public.referral_codes WHERE client_id='synthetic-client';")=="1"
        assert run(actor("synthetic-client")+" SELECT public.my_referral_code();")==code
        print("PASS: simultaneous code creation returns one stable code")
    finally:
        fail_cleanup(a)
        if b is not None: fail_cleanup(b)
    run("INSERT INTO public.referrals(referrer_client_id,name,email,location,note) SELECT 'synthetic-client','Synthetic','seed'||i||'@qa.invalid','','' FROM generate_series(1,19) i;")
    a=session("pf_submit_a")
    try:
        send(a,"SET statement_timeout='12s'; SET ROLE anon; BEGIN; SELECT public.submit_referral('"+code+"','Synthetic A','race-a@qa.invalid','','');")
        assert read(a)=="t"
        rejected=run("SET ROLE anon; DO $$ BEGIN PERFORM public.submit_referral('"+code+"','Synthetic B','race-b@qa.invalid','',''); RAISE EXCEPTION 'Unexpected concurrent success'; EXCEPTION WHEN SQLSTATE 'PT409' THEN IF SQLERRM <> 'Another invite is being processed. Please retry.' THEN RAISE; END IF; END $$; SELECT 'conflict';","pf_submit_b")
        assert rejected=="conflict"
        finish(a)
        result=run("SET ROLE anon; DO $$ BEGIN PERFORM public.submit_referral('"+code+"','Synthetic B','race-b@qa.invalid','',''); RAISE EXCEPTION 'Unexpected quota bypass'; EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'Too many invites today, please try again tomorrow' THEN RAISE; END IF; END $$; SELECT 'quota';")
        assert result=="quota"
        assert run("SELECT count(*) FROM public.referrals WHERE referrer_client_id='synthetic-client';")=="20"
        print("PASS: concurrent public submission rejected with PT409; rolling daily cap stays at 20")
    finally:
        fail_cleanup(a)
    print("PASS: both concurrency cases; disposable synthetic PostgreSQL only")
if __name__=="__main__":
    main()
