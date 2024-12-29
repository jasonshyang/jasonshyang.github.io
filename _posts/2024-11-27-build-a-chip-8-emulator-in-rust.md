---
layout: post
title: Building a Chip8 Emulator in Rust
date: 2024-11-27
categories: [Project]
tags: [rust, emulator]
---
In this article, I'll walk you through the design and implementation of my Chip8 emulator written in Rust.

---

## Overview

Chip8 is an interpreted programming language developed in the 1970s for an early 8-bit microprocessor. This emulator is designed to run Chip8 programs ("ROMs") on modern hardwares, it does this by processing the binary instructions of a Chip8 program, updates the state of the virtual machine (VM), and renders the output to a display (using `ratatui`).

---

## Emulating Chip-8 CPU

```rust
pub struct Chip8 {
    pub i: u16,
    pub pc: u16,
    pub memory: [u8; MEMORY_SIZE],
    pub v: [u8; REGISTERS_SIZE],
    pub stack: [u16; STACK_SIZE],
    pub sp: u16,
    pub dt: u8,
    pub st: u8,
    pub keyboard: [bool; KEYBOARD_SIZE],
    pub display: [bool; DISPLAY_SIZE],
    pub is_drawing: bool,
}
```

### Memory
Chip-8 programs have access to 4KB of memory:

```
Memory Map:
+---------------+= 0xFFF (4095) End of Chip-8 RAM
|               |
|               |
|               |
|               |
|               |
| 0x200 to 0xFFF|
|     Chip-8    |
| Program / Data|
|     Space     |
|               |
|               |
|               |
+- - - - - - - -+= 0x600 (1536) Start of ETI 660 Chip-8 programs
|               |
|               |
|               |
+---------------+= 0x200 (512) Start of most Chip-8 programs
| 0x000 to 0x1FF|
| Reserved for  |
|  interpreter  |
+---------------+= 0x000 (0) Start of Chip-8 RAM
```

The emulator emulates this using an array of `u8` with a fixed length of `0x1000`.

### Registers
Chip-8 has the following registers:
- 16 general purpose 8-bit registers (V0 to VF)
- A 16-bit register (I) for storing memory addresses
- Two 8-bit registers for delay and sound timers
- A 16-bit Program Counter (PC) to store the currently running address
- A 8-bit Stack Pointer (SP) to point to the top of the stack
- A Stack that is an array of 16 16-bit, used for storing return addresses when subroutines are called: when a subroutine is called (using the `CALL` addr instruction), the current value of the program counter (PC) is pushed onto the stack. This allows the program to remember where it left off before jumping to the subroutine. When the subroutine finishes executing (using the `RET` instruction), the program counter is popped from the stack, restoring the address of the instruction that follows the original `CALL` instruction. This allows the program to continue executing from where it left off before the subroutine call.

Because the first 512 bytes (from 0x000 to 0x1FF) are not be used by the programs, the Program Counter starts from the `const MEMORY_START: usize = 0x200`. This is because the first 512 bytes are where the original interpreter was located.

---

## Display
The display is a 64x32 monochrome display, and the emulator emulates this using an array of `bool` with a fixed length of `64*32`.

### Drawing on Display
Chip-8 draws graphics on screen through the use of sprites, through the `DRW Vx, Vy, nibble` instruction.

`Vx` and `Vy` are registers that hold the x and y coordinates where the sprite will be drawn, and `nibble` specifies the number of bytes (rows) in the sprite. The sprite being drawn is read from memory starting at the address stored in `I`

To give a simple example, suppose we want to draw the digit `0` at coordinate `(10, 5)`, below is the sprite data:

```assembly
0xF0, // 11110000
0x90, // 10010000
0x90, // 10010000
0x90, // 10010000
0xF0  // 11110000
```

The instruction is `0xD125`, assuming `I` is set at `0x000` (which is where `0` sprite is stored), `V1` holds the x-coordinate 10, `V2` holds the y-coordinate 5.

If we want to draw a custom sprite, say a dot `0x01`, we can first do the following to set memory at `0x300` to `0x01`:

```assembly
A300  // Set I = 0x300
6001  // Set V0 = 0x01
F055  // Store registers V0 to V0 (x=0) in memory at I
```

Now we can do the same `DRW Vx, Vy, nibble` instruction `0xD121` which will draw the dot.

### Character Sprites
Programs have access to a group of sprites representing the hexadecimal digits `0` through `F`, mainly used for displaying things like scores. According to the specification, these sprites are loaded to the memory at the interpreter area of Chip-8 memory `0x000 to 0x1FF`

```rust
const CHAR_SPRITES: [u8; 80] = [
    0xF0, 0x90, 0x90, 0x90, 0xF0, // 0
    0x20, 0x60, 0x20, 0x20, 0x70, // 1
    0xF0, 0x10, 0xF0, 0x80, 0xF0, // 2
    0xF0, 0x10, 0xF0, 0x10, 0xF0, // 3
    0x90, 0x90, 0xF0, 0x10, 0x10, // 4
    0xF0, 0x80, 0xF0, 0x10, 0xF0, // 5
    0xF0, 0x80, 0xF0, 0x90, 0xF0, // 6
    0xF0, 0x10, 0x20, 0x40, 0x40, // 7
    0xF0, 0x90, 0xF0, 0x90, 0xF0, // 8
    0xF0, 0x90, 0xF0, 0x10, 0xF0, // 9
    0xF0, 0x90, 0xF0, 0x90, 0x90, // A
    0xE0, 0x90, 0xE0, 0x90, 0xE0, // B
    0xF0, 0x80, 0x80, 0x80, 0xF0, // C
    0xE0, 0x90, 0x90, 0x90, 0xE0, // D
    0xF0, 0x80, 0xF0, 0x80, 0xF0, // E
    0xF0, 0x80, 0xF0, 0x80, 0x80, // F
];

for i in 0..CHAR_SPRITES.len() {
    chip8.memory[i] = CHAR_SPRITES[i];
}
```

### Emulating Display Update
We first need to load all the parameters
```rust
let size = nibble as usize;
let x = self.v[x] as usize;
let y = self.v[y] as usize;
```

We then need to loop through each line of the sprite to draw in display, and we know the number of iteractions is `size`.

For each iteraction, we first load the byte to a buffer
```rust
let buffer = self.memory[self.i as usize + line]
```

Each byte has 8 pixels, we can mask each byte to extract if there is a pixel to be drawn by:
```rust
for pixel in 0..8 {
  if (buffer & (0x80 >> pixel)) != 0 {
    //..//
  }
  //..//
}
```

To draw the pixel, we need to locate its position in the display array, we can find a 2D position in a 1D array by `x + y * DISPLAY_WIDTH`.

We also need to wrap it around the display as per the specification -- "if the sprite is positioned so part of it is outside the coordinates of the display, it wraps around to the opposite side of the screen". We can do this with a `%` operation.

Finally, we need to XOR the pixel using `^=` operator.

```rust
let size = nibble as usize;
let x = self.v[x] as usize;
let y = self.v[y] as usize;

self.v[0x000F] = 0; // Reset collision flag

for line in 0..size {
    let buffer = self.memory[self.i as usize + line];
    for pixel in 0..8 {
        if (buffer & (0x80 >> pixel)) != 0 {
            let i = (x + pixel) % DISPLAY_WIDTH
                + ((y + line) % DISPLAY_HEIGHT) * DISPLAY_WIDTH;
            if self.display[i] {
                self.v[0x000F] = 1; // Collision detected
            }
            self.display[i] ^= true; // XOR the pixel value
        }
    }
}
```

### Detecting Collision
Chip-8 uses the `VF` register for storing collision flag. The `DRW` instruction updates the display by XORing, and any pixels are erased, `VF` is set to 1, else it is 0. This simple and elegant solution powers many games like Pong.

---

## Opcode Decoding

Opcode is a 2 bytes long instruction, the goal of the decoding is to extract the specific parts of the opcode to determine the type of instruction and its parameters.

### How to Read Opcode

- `most significant nibble`: A 4-bit value, the upper 4 bits of the high byte of the instruction, this determines the type of instruction
- `x`: A 4-bit value, the lower 4 bits of the high byte of the instruction
- `y`: A 4-bit value, the upper 4 bits of the low byte of the instruction
- `kk or byte` - An 8-bit value, the lowest 8 bits of the instruction
- `nnn or addr` - A 12-bit value, the lowest 12 bits of the instruction
- `n / nibble` - A 4-bit value, the lowest 4 bits of the instruction

```
Example: 0x6A02

- `6` is the most significant nibble which determine the type of instruction. In this case, it is the type `6xkk`, which is the `LD Vx, byte` instruction, this instruction sets register Vx as value kk.
- `A` is the lower 4 bits of the high byte of the instruction. In this case, we know the register we want to set is VA
- `0` is the upper 4 bits of the low byte of the instruction. In this case, we are coming it with the next nibble to know what value we set
- `2` is the upper 4 bits of the low byte of the instruction. In this case, we know the value we want to set to VA is `0x02`
```

### How to Decode

The parameters can be extracted by:

```rust
let x = ((opcode >> 8) & 0x000F) as usize;
let y = ((opcode >> 4) & 0x000F) as usize;
let kk = (opcode & 0x00FF) as u8;
let nnn = (opcode & 0x0FFF) as u16;
let nibble = (opcode & 0x000F) as u8;
```

The opcode can then be process by masking the most significant nibble and matching it against the specifications

```rust
match opcode & 0xF000 {
    0x0000 => {
        match nibble {
            0x0000 => {
                self.display = [false; DISPLAY_SIZE];
                self.is_drawing = true;
            }
            0x000E => {
                self.sp -= 1;
                self.pc = self.stack[self.sp as usize];
            }
            _ => {
                self.pc = nnn;
            }
        }
    }
    // ... //
}
```

---

## Inputs

Chip-8 programs use a keyboard which has a 16-key hexadecimal keypad

```sh
1 2 3 C
4 5 6 D
7 8 9 E
A 0 B F
```

This is emulated by using an array of `bool` with a fixed length of `16`. If a key is pressed in a given CPU cycle, this is set to `true`, else `false`.

The key press values are read by opcodes such as `Ex9E - SKP Vx`, which skips next instruction if key with the value of Vx is pressed (this is done by incrementing PC by 2), or `ExA1 - SKNP Vx` which skips if key is not pressed. 

Another one is `0xFx0A - LD Vx, K` which waits for a key press, store the value of the key in Vx (this is done by decrementing PC by 2, which means the next CPU cycle the same opcode will be read and effectively blocking the CPU to continue)

In my implementation I have used `ratatui` as my terminal UI which uses `crossterm` to provide keyboard event.

---

## Putting It All Together
Now let's look at how these components are put together to create an emulator that can run Chip-8 roms.

### Main Loop
For every CPU cycle, we first run the CPU cycle to process opcode. If the result of opcode requires a screen update, we then update the Terminal UI with the updated display data. We also check if there is keyboard activity, and update the keyboard according.

```rust
loop {
    if last_cycle.elapsed() >= cycle_rate {
        chip8.run_cycle();
        last_cycle = Instant::now();
    }

    if chip8.is_drawing {
        let display_data = chip8.get_display_data();
        update_display(&mut terminal, &display_data).unwrap();
        chip8.is_drawing = false;
    }

    if event::poll(Duration::from_millis(1))? {
        if let Event::Key(key) = event::read()? {
            match key.kind {
                KeyEventKind::Press => {
                    if key.code == KeyCode::Esc {
                        return Ok(());
                    }
                    if let Some(key) = key_map(key.code) {
                        chip8.set_key(key);
                    }
                }
                _ => {}
            }
        }
    }
}

```

### CPU Cycle

```rust
    pub fn run_cycle(&mut self) {
        let opcode1 = (self.memory[self.pc as usize] as u16) << 8;
        let opcode2 = self.memory[self.pc as usize + 1] as u16;
        let opcode = opcode1 | opcode2;

        self.pc += 2;

        self.process_opcode(opcode);

        self.update_timers();
    }
```

For every CPU cycle, we first read the opcode from memory. Note that memory is stored in a `u8` array and opcode is `u16`, we will need to fetch two `u8` from memory at PC and PC+1, and combine them into a `u16` opcode.

We then increment the PC by 2, process the opcode, and update the timer.

### Updating Terminal UI
Drawing on the actual terminal is similar to how the `DRW` opcode works, below is an implementation using `ratatui`.

```rust
fn update_display(terminal: &mut DefaultTerminal, display_data: &[bool]) -> io::Result<()> {
    terminal.draw(|frame| {
        let width = chip8::DISPLAY_WIDTH;
        let height = chip8::DISPLAY_HEIGHT;
        let mut text = String::new();
        for y in 0..height {
            for x in 0..width {
                let index = y * width + x;
                let pixel = display_data[index];
                text.push_str(if pixel { "█" } else { " " });
            }
            text.push_str("\n");
        }
        frame.render_widget(block, frame.area());
    })?;
    Ok(())
}
```

### Map Keyboards
Mapping of keyboard can be simply done with a match.

---

## Conclusion

This was one of the first few projects I worked on in Rust, and it turns out to be a very good learning for me (and a lot of fun!).

I wanted to build this as I was researching on how the Ethereum Virtual Machine (EVM) works. Although the two systems have vastly different purposes, there are some basic concepts that overlap between these two.

Through researching and implementing the Chip-8 Emulator, I got to learn about how a Virtual Machine processes instructions, handles registers, manage memories and interacts with system IOs.