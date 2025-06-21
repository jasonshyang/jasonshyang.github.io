---
layout: post
title: HTTP Requests and Responses - From Raw Bytes to Structured Data
date: 2025-06-20
categories: [Concepts]
tags: [http]
---
Recently I got curious on how exactly does HTTP request and response work - you send a request, you get a response, but what does the data look like? How do crates like `http` `hyper` know what the response status is, how do they get interpreted?

In this article we can explore together on how the data flow works over the wire, and how it gets parsed and represented in Rust.

## HTTP vs TCP
Let's first quickly look at HTTP (Hypertext Transfer Protocol) and TCP (Transmission Control Protocol). 

This [Stack Overflow article](https://stackoverflow.com/questions/23157817/http-vs-tcp-ip-send-data-to-a-web-server) provides an excellent explanation on the layered networking model, which would look something like this:

```zsh
+------------------------------+
|  Application Layer           | ← HTTP, HTTPS, SMTP, FTP
+------------------------------+
|  Transport Layer             | ← TCP, UDP
+------------------------------+
|  Network Layer               | ← IP (Internet Protocol)
+------------------------------+
|  Link Layer                  | ← Ethernet, Wi-Fi (802.11)
+------------------------------+
|  Physical Layer              | ← Electrical Signals, Radio Waves, Light Pulses
+------------------------------+
```
From bottom to top:
* **Physical Layer**: transmits raw bits over physical media like cables, radio waves, or light (e.g., Ethernet cables, Wi-Fi signals)
* **Link Layer**: handles communication between devices on the same local network, e.g. how computer talks to "router"
* **Network Layer**: routes traffics between different networks using IP addresses
* **Transport Layer**: provides end-to-end communication between applications on different hosts, e.g. TCP, UDP
* **Application Layer**: defines protocols for specific types of communication between software applications

Here we focus on the top two layers, where TCP sits in the Transport Layer, and HTTP sits in the Application Layer on top of TCP. 

TCP does a lot behind the scenes: it ensures data is delivered in order, manages acknowledgments between sender and receiver, and controls congestion and flow. A full exploration of TCP's inner workings deserves its own article. For now, it's enough to understand TCP as an abstraction that provides a continuous byte stream between our HTTP client and server.

When a client (e.g. browser) makes an HTTP request, what happens behind the scene is:
* it opens a TCP connection to the server
* it sends a series of bytes over the TCP stream using HTTP format
* the server reads the data (using the same format) and reply with, again HTTP formatted, response in bytes

So HTTP is essentially the format of the bytes we send over the TCP stream.

## HTTP Request
Let's try examine what a HTTP request would look like. We can run a very simple server like this:
```rust
#[tokio::main]
async fn main() -> std::io::Result<()> {
    let listener = TcpListener::bind("127.0.0.1:8080").await?;
    loop {
        let (mut socket, _) = listener.accept().await?;
        tokio::spawn(async move {
            let mut buf = [0; 4096];
            match socket.read(&mut buf).await {
                Ok(n) => {
                    let request_data = &buf[..n];
                    println!("Raw Bytes:\n{:?}", request_data);
                }
                _ => {}
            }
        });
    }
}
```

This server listens on localhost port 8080: for every incoming connection, it spawns a new Tokio task, reads the request data into a buffer, and prints the raw bytes received. Note that normally the server should send a response back to the client, but we are skipping that here to focus solely on inspecting the incoming HTTP request.

Now we can send a very simple request like this over curl.
```zsh
curl -X POST 127.0.0.1:8080 \
     -H "Content-Type: application/json" \
     -d '{"msg": "Hello!"}'
```

This is what we get from our console log.
```zsh
[80, 79, 83, 84, 32, 47, 32, 72, 84, 84, 80, 47, 49, 46, 49, 13, 10, 72, 111, 115, 116, 58, 32, 49, 50, 55, 46, 48, 46, 48, 46, 49, 58, 56, 48, 56, 48, 13, 10, 85, 115, 101, 114, 45, 65, 103, 101, 110, 116, 58, 32, 99, 117, 114, 108, 47, 56, 46, 55, 46, 49, 13, 10, 65, 99, 99, 101, 112, 116, 58, 32, 42, 47, 42, 13, 10, 67, 111, 110, 116, 101, 110, 116, 45, 84, 121, 112, 101, 58, 32, 97, 112, 112, 108, 105, 99, 97, 116, 105, 111, 110, 47, 106, 115, 111, 110, 13, 10, 67, 111, 110, 116, 101, 110, 116, 45, 76, 101, 110, 103, 116, 104, 58, 32, 49, 55, 13, 10, 13, 10, 123, 34, 109, 115, 103, 34, 58, 32, 34, 72, 101, 108, 108, 111, 33, 34, 125]
```

These are not human readable, we can try decoding it with `String::from_utf8_lossy()` to a UTF-8 String, the `lossy` here means this method will replace invalid data with a `�`.

This gives us something like this:
```
"POST / HTTP/1.1\r\nHost: 127.0.0.1:8080\r\nUser-Agent: curl/8.7.1\r\nAccept: */*\r\nContent-Type: application/json\r\nContent-Length: 17\r\n\r\n{\"msg\": \"Hello!\"}"
```

We can format this nicer:
```
POST / HTTP/1.1
Host: 127.0.0.1:8080
User-Agent: curl/8.7.1
Accept: */*
Content-Type: application/json
Content-Length: 17

{"msg": "Hello!"}
```

This is very interesting, there's a lot going on here, so let's go through them one by one.

#### Request Line
`POST / HTTP/1.1` is the **Request Line**:
* `POST` is the HTTP method, telling the server the client wants to send data
* `/` is the request path, here we are hosting it on root so its just a `/`
* `HTTP/1.1` is the HTTP version

#### Headers
There are several headers in the call we made from curl:
* `Host: 127.0.0.1:8080` specifies the server’s hostname and port
* `User-Agent: curl/8.7.1` indicates the client software making the request
* `Accept: */*` tells the server the client can accept any media type in the response
* `Content-Type: application/json` Specifies the format of the data being sent in the request body is JSON
* `Content-Length: 17` indicates the size of the request body in bytes

Another thing to notice here is, although we only specified one header in our curl command, there are several headers added automatically by curl. Postman does the same thing, we can check that in a postman request's `Headers` section by clicking on `hidden` to reveal what it includes. These are included to make sure the request are fully valid and useful without the user needing to specify every detail manually.

#### Body
The JSON data we sent `{"msg": "Hello!"}`, for which the server knows from the headers that it is encoded as JSON, and has a size of 17 (we can count it, it is indeed 17).

### Summary
In this section, we learned that an HTTP request is a byte stream that follows the format: Request Line → Headers → Empty Line → Body. The first line is the Request Line, followed by the Headers, where each Header is separated by a CRLF `\r\n`. The end of the Header section is marked by an empty line, i.e., a double CRLF `\r\n\r\n`, which separates the Headers from the Body (Body is optional).

## HTTP Response
HTTP Response also has a clear structure with several parts.

Similar to the HTTP Request, we can make a simple request and examine the response, let's try that on `httpbin`:
```rust
#[tokio::main]
async fn main() -> std::io::Result<()> {
    let mut stream = TcpStream::connect("httpbin.org:80").await?;
    let request = b"GET /get HTTP/1.1\r\nHost: httpbin.org\r\nConnection: close\r\n\r\n";
    stream.write_all(request).await?;
    let mut response = Vec::new();
    stream.read_to_end(&mut response).await?;
    let response_str = String::from_utf8_lossy(&response);
    println!("{}", response_str);

    Ok(())
}
```

This opens a TCP connection to `httpbin.org` on port 80 (the default HTTP port), crafts a `HTTP GET` request following the `HTTP/1.1` format, writes it to the stream, reads the response into a byte buffer, then converts it to a UTF-8 string and prints it out.

Here's what we get back
```
HTTP/1.1 200 OK
Date: Sat, 21 Jun 2025 08:36:23 GMT
Content-Type: application/json
Content-Length: 197
Connection: close
Server: gunicorn/19.9.0
Access-Control-Allow-Origin: *
Access-Control-Allow-Credentials: true

{
  "args": {...}, 
  "headers": {...}, 
  "origin": "...", 
  "url": "..."
}
```

Similar to previous section, let's go through each parts and understand it.

#### Status Line
`HTTP/1.1 200 OK` is the **Status Line**:
* `HTTP/1.1` is the HTTP version used in the response
* `200` is the status code, meaning the request was successful
* `OK` is the status text associated with the code, providing a brief description

#### Headers
Similar to HTTP Request, a HTTP Response also contains headers:
* `Date: Sat, 21 Jun 2025 08:36:23 GMT` is the datetime when the response was generated
* `Content-Type: application/json` is same meaning as in the Request format, indicating the Body's media type
* `Content-Length: 197` again same meaning, indicating the size of the Body
* `Connection: close` indicates that the connection is closed after response
* `Server: gunicorn/19.9.0` identifies the software used to handle the HTTP request on server side
* `Access-Control-Allow-Origin: *` means any origin is allowed to access the resource. 
* `Access-Control-Allow-Credentials: true` means the the server allows credentials in cross-origin requests if the origin is allowed.
* Note: the above two are parts of CORS (Cross-Origin Resource Sharing), which is outside of the scope of this article.

#### Body
This is the actual useful data we got back from `httpbin` encoded as JSON, in this case just the things we sent in the request.

### Summary
In this section, we learned that an HTTP response is similar to an HTTP request, which follows the format of Status Line → Headers → Empty Line → Body.

## Conclusion
Under the hood, `HTTP` is just a well-defined format for exchanging bytes over a `TCP` stream. Whether you're sending a request or receiving a response, it's all plain text following a specific structure: a starting line (`Request Line` or `Status Line`), a series of `Headers`, an empty line to mark the end of headers, and an optional `Body`.

By looking at real examples using TcpStream, we saw exactly what gets sent and received over the wire. This helps us better understand how HTTP clients and servers know how to parse these bytes into structured `Request` and `Response` types. Libraries like `http` implement the HTTP specification, splitting the raw stream based on predictable patterns like CRLFs and headers, so we can access each parts.

Hopefully, this gives you a clearer mental model of how data moves between client and server in an HTTP interaction, and how Rust crates work with that data at a low level.