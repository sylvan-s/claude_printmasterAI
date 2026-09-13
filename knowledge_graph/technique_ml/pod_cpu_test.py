import multiprocessing as mp, time
def burn(_):
    t=time.process_time(); e=time.time()+3.0; x=0
    while time.time()<e: x+=1
    return time.process_time()-t
if __name__ == "__main__":
    t=time.time(); x=0
    for i in range(10_000_000): x+=i
    single = time.time()-t
    with mp.get_context("fork").Pool(16) as p:
        r=p.map(burn, range(16))
    print(f"effective_cores={sum(r)/3:.1f} single_core_10M_loop={single:.2f}s")
