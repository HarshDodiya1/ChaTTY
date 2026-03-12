Go through my codebase, and @PLATFORM.md and CLAUDE.md also @SETUP.md, Plan the issue first that I am telling to you.

Understand the platform first and how I am connecting to other peer for Chatting. 

When connected over same wifi Connection in different laptops,                                                                                                                                                                        
I am facing the issue because not getting peer name in the sidebar.                                 
My other computer is getting my user as online peer but it is not showing me it's status in my peer list.

I have done this on my PC:                                            
./target/release/ChaTTY --name harsh --peer <rishabh-ip>:7878

# On rishabh's laptop:                                  
./target/release/ChaTTY --name rishabh --peer <harsh-ip>:7878          

Only one peer at a time can discover the other person, but second person not able to see.
WHy does this thing happening, just find the root cause and fix the exact problem, go through the code again and fix it anyhow.