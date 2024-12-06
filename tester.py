import asyncio
import json
import time
import websockets
import requests
import hashlib
import random
from consolemenu import *
from consolemenu.items import *
import tkinter as tk
from hashlib import md5
from zeroconf import ServiceBrowser, Zeroconf
import socket
import os
from tkinter import filedialog as fd
import argparse

# Add command line argument parsing
parser = argparse.ArgumentParser(description='FAS CB Tester')
parser.add_argument('--ip', type=str, help='Direct IP address for FAS CB')
args = parser.parse_args()

ipaddress = []
fascb_names = []
wsRun = True

# Configure the parameters below
nozzleId = "0031" 
vTAG = "E200001D8914005717701BFC"
hours = 200
refillLiters = 40
liter_increment = 10
numRefills = 100
target_fas_name = "FAS_CB57"
image_path = "./refill.jpg"
direct_ip = args.ip  # New parameter for direct IP




try:
    with open("settings.json", "r") as file:
        jSettings = json.load(file)

        nozzleId = jSettings["nozzleId"]
        vTAG = jSettings["vTAG"]
        hours = jSettings["hours"]
        refillLiters = jSettings["refillLiters"]
        liter_increment = jSettings["liter_increment"]
        numRefills = jSettings["numRefills"]
        target_fas_name = jSettings["target_fas_name"]
        image_path = jSettings["image_path"]
        # Load direct_ip from settings if it exists and wasn't provided via command line
        if not direct_ip:
            direct_ip = jSettings.get("direct_ip", None)

except FileNotFoundError:
    print("The specified JSON file does not exist.")
except json.JSONDecodeError as e:
    print(f"Error decoding JSON: {str(e)}")
except Exception as e:
    print(f"An error occurred: {str(e)}")

def submit_form():
    global nozzleId, vTAG, hours, refillLiters, liter_increment, numRefills
    global target_fas_name, image_path, direct_ip

    if not os.path.exists(image_path):
        print("Invalid image path")
        return

    nozzleId = nozzleId_entry.get()
    vTAG = vTAG_entry.get()
    hours = int(hours_entry.get())
    refillLiters = int(refillLiters_entry.get())
    liter_increment = int(liter_increment_entry.get())
    numRefills = int(numRefills_entry.get())
    target_fas_name = target_fas_name_entry.get()
    direct_ip = direct_ip_entry.get()  # New entry for direct IP
    
    root.destroy()

def pick_image():
    global image_path
    image_path = fd.askopenfilename()
    refill_image_entry.configure(text=image_path)

    


def on_window_delete():   
    exit()


# Create the main window
# Add UI elements for direct IP
root = tk.Tk()
root.protocol('WM_DELETE_WINDOW', lambda: exit())
root.title("FAS CB Tester")
root.geometry("300x450")  # Increased height for new field

# Create and configure a label
label = tk.Label(root, text="Select an option:")
label.pack()


# Add new direct IP entry field
direct_ip_label = tk.Label(root, text="Direct IP (optional):")
direct_ip_entry = tk.Entry(root)
direct_ip_entry.insert(0, direct_ip if direct_ip else "")
direct_ip_label.pack()
direct_ip_entry.pack()

nozzleId_label = tk.Label(root, text="Nozzle ID:")
nozzleId_entry = tk.Entry(root)
nozzleId_entry.insert(0, nozzleId)
nozzleId_label.pack()
nozzleId_entry.pack()


vTAG_label = tk.Label(root, text="TAG:")
vTAG_entry = tk.Entry(root)
vTAG_entry.insert(0, vTAG)
vTAG_label.pack()
vTAG_entry.pack()
                   
hours_label = tk.Label(root, text="Hours:")
hours_entry = tk.Entry(root)
hours_entry.insert(0, hours)
hours_label.pack()
hours_entry.pack()
    

refillLiters_label = tk.Label(root, text="Refill Liters:")
refillLiters_entry = tk.Entry(root)
refillLiters_entry.insert(0, refillLiters)
refillLiters_label.pack()
refillLiters_entry.pack()      

liter_increment_label = tk.Label(root, text="Liter increment:")
liter_increment_entry = tk.Entry(root)
liter_increment_entry.insert(0, liter_increment)
liter_increment_label.pack()
liter_increment_entry.pack() 

numRefills_label = tk.Label(root, text="# Refills:")
numRefills_entry = tk.Entry(root)
numRefills_entry.insert(0, numRefills)
numRefills_label.pack()
numRefills_entry.pack() 


target_fas_name_label = tk.Label(root, text="FAS CB Name:")
target_fas_name_entry = tk.Entry(root)
target_fas_name_entry.insert(0, target_fas_name)
target_fas_name_label.pack()
target_fas_name_entry.pack() 

refill_image_label = tk.Label(root, text="Refill Image:")
refill_image_entry = tk.Label(root, text=image_path)
refill_image_label.pack()
refill_image_entry.pack() 

file_button = tk.Button(root, text="...", command=lambda: pick_image())
file_button.pack()

submit_button = tk.Button(root, text="Submit", command=lambda: submit_form())
submit_button.pack()

root.mainloop()

# construct a json object

jSettings = {
    "nozzleId": nozzleId,
    "vTAG": vTAG,
    "hours": hours,
    "refillLiters": refillLiters,
    "liter_increment": liter_increment,
    "numRefills": numRefills,
    "target_fas_name": target_fas_name,
    "image_path": image_path,
    "direct_ip": direct_ip
}

# Save this to the setting file.
with open("settings.json", "w") as file:
    # Write the string to the file
    file.write(json.dumps(jSettings))



# # Create the menu
# menu = ConsoleMenu("Title", "Subtitle")
# menu_item = MenuItem("Menu Item")   
# # A SelectionMenu constructs a menu from a list of strings
# selection_menu = SelectionMenu(["item1", "item2", "item3"])
# # A SubmenuItem lets you add a menu (the selection_menu above, for example)
# # as a submenu of another menu
# submenu_item = SubmenuItem("Submenu item", selection_menu, menu)
# # Once we"re done creating them, we just add the items to the menu
# menu.append_item(menu_item)
# menu.append_item(submenu_item)

# # Finally, we call show to show the menu and allow the user to interact
# menu.show()




ppl = 20
randLiters = 10
class MyListener:

    def update_service(self, zeroconf, type, name):
        print("Update %s service" % (name,))
        
    def remove_service(self, zeroconf, type, name):
        print("Service %s removed" % (name,))

    def add_service(self, zeroconf, type, name):
        info = zeroconf.get_service_info(type, name)

        global ipaddress
        global fascb_names


        ipaddress.append(socket.inet_ntoa(info.addresses[0]))
        fascb_names.append(info.server)
        print( info.server + " @" + ipaddress[-1])

        # print("Service %s added, IP address: %s" % (name, ipaddress))


fascb_ip = "10.0.0.43/api"
# fascb_ip = "10.0.0.40"
command = ""

username = "FasAdmin"
pwd = "Minetec123#"

token = ""


async def login():
    global token

    url = "http://" + fascb_ip + "/ping"
    x = requests.get(url)
    print(x.text)

    credentials = {"username": username, "state": "initial"}

    if x.text.startswith("pong"):
        #         Send and authentication request
        url = "http://" + fascb_ip + "/auth"

        respJson = requests.post(url, json=credentials)
        print(respJson.text)

        # decode the response
        y = json.loads(respJson.text)

        if y["challenge"] != "":
            print(y["challenge"])
            # Hash the passsword and send it.
            unHashed = username + ":" + pwd
            m = hashlib.md5()
            m.update(unHashed.encode("utf"))
            md5string = m.hexdigest()

            print(md5string)

            y["key"] = md5string

            respJson = requests.post(url, json=y)

            print(respJson.text)

            y = json.loads(respJson.text)

            if y["token"] != "":
                token = y["token"]
                print(token)
                return True

    return False


def send_op_req(payload):
    url = "http://" + fascb_ip + "/operation"
    respJson = requests.post(url, json=payload)

    # print("SEND: ")
    # print(payload)


    r = json.loads(respJson.text)

    #Stringify the response and print it
    print("RESP: " + json.dumps(r))
    
    if "message" in r:
        print("MSG: " + r["message"])
        

    if r["response"] == "invalid":
        print("Response is invalid")
    
    return r


def refill_request(token):
    return send_op_req({"request": "refill_req", "token": token})


def refill_start(token, hours):
    print ("Refill Start")
    return send_op_req({"request": "refill_drf", "token": token, "refill_op_workinghours" : hours})


def cancel_refill(token):
    send_op_req({"request": "refill_finish", "token": token})


def query_refill_params(token):
    return send_op_req({"request": "refill_params", "token": token
                 })

def end_refill(token):
    send_op_req({"request": "refill_finish", "token": token
                 })

def request_vehicle_info():
   r = send_op_req({"request": "vehicle_info", "token": token })
   return r

def send_rfid_mock():
    print("Sending RFID mock")
    global command
    command = "stm_command(echo(rfid_get("+nozzleId+","+vTAG+",1212)))\n"




def upload_image(token):
    url = "http://" + fascb_ip + "/upload"

    if os.path.exists(image_path):
        files = {"file": (image_path, open(image_path, "rb"), "application/txt", {"Expires": "0"})}
        print("Uploading IMAGE " + image_path)
    else:
        print("No image ./refill.jpg in directory")
        return

    r = requests.post(url, files=files)
    print("Uploaded IMAGE " + r.text)



async def main_task():
    global command
    global wsRun

    for m in range(0, numRefills):
        try:
            if await login():
                print("Logged in Successfully " + token + " " + str(m))

                # send a refill request
                r=refill_request(token)

                if r["response"] == "invalid":
                    time.sleep(30)
                    continue

                time.sleep(2)

                while True:
                    r=request_vehicle_info()
                    print(r)

                    if r["response"] == "vehicle_info" or r["response"] == "invalid" or r["response"] == "invalid_token":
                        break

                    send_rfid_mock()
                    
                    await asyncio.sleep(2)

                upload_image(token)

                # await asyncio.sleep(1)

                r = refill_start(token, hours)
                await asyncio.sleep(2)
                print('DEBUG',r)
                
                meter_val = 10
                meter_max = 10 + refillLiters*ppl + random.randint(0,2*liter_increment * ppl)
                print("MAX " + str(meter_max))

                isLast = False

                while True:
                    r = query_refill_params(token)

                    if (r["response"] == "invalid" or r["response"] == "invalid_token"):
                        break

                    await asyncio.sleep(1)
                    command = "stm_command(echo(meter_read("+str(meter_val)+")))\n"
                    await asyncio.sleep(1)
                    command = "stm_command(echo(rfid_match("+nozzleId+",2.3)))\n"


                    if isLast:
                        end_refill(token)
                        print("ENDED REFILL #" + str(m))
                        break

                    if (meter_val > meter_max):
                        isLast = True
                        meter_val = meter_max
                    
                    meter_val += liter_increment * ppl

                await asyncio.sleep(10)

        except Exception as error:
            print("Exception ", error)
            await asyncio.sleep(5)
            continue

        await asyncio.sleep(5)
    
    wsRun = False


async def websocket_task():

    global command

    while wsRun:
        async with websockets.connect("ws://" + fascb_ip + "/ws") as websocket:

            while wsRun:
                if len(command) > 0:
                    try:
                        print("Sending WS message " + command)
                        await websocket.send(command)
                        # time.sleep(1)  # wait and then do it again
                    except Exception as e:
                        print(e)
                        break

                    command = ""

                await asyncio.sleep(1)




# Skip device search if direct IP is provided
if direct_ip:
    print(f"Using direct IP address: {direct_ip}")
    fascb_ip = direct_ip
else:
    # Existing device search logic
    zeroconf = Zeroconf()
    listener = MyListener()
    browser = ServiceBrowser(zeroconf, "_fas._tcp.local.", listener)

    print("Searching for control boxes")

    while len(ipaddress) == 0:
        time.sleep(1)
    
    time.sleep(2)
    browser.cancel()

    if len(ipaddress) > 0: 
        for n in range(0, len(ipaddress)):
            ip = ipaddress[n]
            name = fascb_names[n][0:fascb_names[n].index(".")]
            print(str(n) + " " + name + " - " + ip)

    target_fas_name = target_fas_name + ".local."

    if len(ipaddress) > 0:
        if target_fas_name in fascb_names:
            print("Selecting device " + target_fas_name)
            devNo = fascb_names.index(target_fas_name)
        else:
            print("Choose FAS device")
            devNo = int(input(""))
    else:
        devNo = 0

    if 0 <= devNo < len(ipaddress):
        fascb_ip = ipaddress[devNo]



loop = asyncio.get_event_loop()
try:
    asyncio.ensure_future(main_task())
    #asyncio.ensure_future(websocket_task())
    loop.run_forever()
except KeyboardInterrupt:
    pass
finally:
    print("Closing Loop")
    loop.close()

