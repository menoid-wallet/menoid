// SPDX-License-Identifier: GPL-3.0
/*
    Copyright 2021 0KIMS association.

    This file is generated with [snarkJS](https://github.com/iden3/snarkjs).

    snarkJS is a free software: you can redistribute it and/or modify it
    under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    snarkJS is distributed in the hope that it will be useful, but WITHOUT
    ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
    or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public
    License for more details.

    You should have received a copy of the GNU General Public License
    along with snarkJS. If not, see <https://www.gnu.org/licenses/>.
*/

pragma solidity >=0.7.0 <0.9.0;

contract TransferVerifier {
    // Scalar field size
    uint256 constant r    = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    // Base field size
    uint256 constant q   = 21888242871839275222246405745257275088696311157297823662689037894645226208583;

    // Verification Key data
    uint256 constant alphax  = 20491192805390485299153009773594534940189261866228447918068658471970481763042;
    uint256 constant alphay  = 9383485363053290200918347156157836566562967994039712273449902621266178545958;
    uint256 constant betax1  = 4252822878758300859123897981450591353533073413197771768651442665752259397132;
    uint256 constant betax2  = 6375614351688725206403948262868962793625744043794305715222011528459656738731;
    uint256 constant betay1  = 21847035105528745403288232691147584728191162732299865338377159692350059136679;
    uint256 constant betay2  = 10505242626370262277552901082094356697409835680220590971873171140371331206856;
    uint256 constant gammax1 = 11559732032986387107991004021392285783925812861821192530917403151452391805634;
    uint256 constant gammax2 = 10857046999023057135944570762232829481370756359578518086990519993285655852781;
    uint256 constant gammay1 = 4082367875863433681332203403145435568316851327593401208105741076214120093531;
    uint256 constant gammay2 = 8495653923123431417604973247489272438418190587263600148770280649306958101930;
    uint256 constant deltax1 = 7251611503052469683574685308868823126311648995448921362834079097725341587748;
    uint256 constant deltax2 = 6868098031733929778216426664331567129243447162084284936535529959596474978429;
    uint256 constant deltay1 = 5786958976381954006030092859941154406662849916433699295884894992325553809928;
    uint256 constant deltay2 = 17309759492380934524395422687740366544073998914170798584551939642815910876749;

    
    uint256 constant IC0x = 12387934053892889842043812845847816864566545997300342274477105365275757340307;
    uint256 constant IC0y = 16346597852460823679735455510723394118462050783423962744885455631512971208364;
    
    uint256 constant IC1x = 13056748392228150732378095682977241256178751588539353847132460129403146084788;
    uint256 constant IC1y = 7648026345835304873327729325961801038422529756256325444155463110465411783168;
    
    uint256 constant IC2x = 3204375347474563836983873856710737126397753510583389953617859219870115282602;
    uint256 constant IC2y = 6739217773665097086902621096649059991304270594975883240842014784115177210021;
    
    uint256 constant IC3x = 4255073102453416012394507508630948042763131283974604294782056785679069545255;
    uint256 constant IC3y = 4569270689475086442265190842661305358560711782409467657221524650755417454517;
    
    uint256 constant IC4x = 16078593804143545527178118828351272296495677139962278978021341893165844160286;
    uint256 constant IC4y = 20713865072468080471247956846906278066775944648253714935988904567474295101375;
    
    uint256 constant IC5x = 458154337252100650465501560780968932247216791816394976934783033995614536384;
    uint256 constant IC5y = 10085966904772216295583372422483369956769424575814824836935610833362330130101;
    
    uint256 constant IC6x = 5444280254445905893465801789608045384885972001872705998135862423472422183660;
    uint256 constant IC6y = 19842843198873918196605264128165585554711867608411640083508087181160199134908;
    
    uint256 constant IC7x = 1593989880861935780477172181776559851280492407545504361604453861926027269373;
    uint256 constant IC7y = 9621929283168804907716372950908076362037793813029872351701114509463387313731;
    
    uint256 constant IC8x = 7219025746023301298635827901339019743805682600509617530625461192397407390930;
    uint256 constant IC8y = 984631267383884360743070484644427689031129666585528280945049748749069834880;
    
    uint256 constant IC9x = 6937583416193603947531464445369092995458530558578427963424547089908888735498;
    uint256 constant IC9y = 435622162737933378334518221870668796600548640853467338126645422665373814447;
    
    uint256 constant IC10x = 13234941122344639988878474588698698730022780773720290786901198471586003550283;
    uint256 constant IC10y = 3924386011324449511144887072088821889856688963208955773013947228178221870819;
    
    uint256 constant IC11x = 668661011171346284924384416327944574619341389968872815253005707469401418481;
    uint256 constant IC11y = 3966262479654064112784803855360201197095957527106611619472744945170752003464;
    
    uint256 constant IC12x = 20134570745830759477916413573498125515522268073434133638624812041653783819712;
    uint256 constant IC12y = 21671457239939808708370000715502104728844567636620153661842825370456602296555;
    
    uint256 constant IC13x = 7349545798131452416144362026451021660452101201253355733136500496587382130053;
    uint256 constant IC13y = 3942335311192540963644725730341020648539182882356149954738018444591160005787;
    
    uint256 constant IC14x = 16109468993248128994906756218895950734881259716473639560617757010885182446345;
    uint256 constant IC14y = 1175023086641386576806974306464426352949786612877920354247757848942677468346;
    
    uint256 constant IC15x = 15150104369059292746825581666683372496078045894436286293632044639341713943234;
    uint256 constant IC15y = 309388962519093981048320436375587768352263912152332011677795144072892566235;
    
    uint256 constant IC16x = 10058294793589370890800415885250077852415884398115263018129651260829670266288;
    uint256 constant IC16y = 12586323926848767917700709752544133815721513551944605073326460475643800237802;
    
    uint256 constant IC17x = 6939216889563526758858965463457230996771235232573801628855988407800681886608;
    uint256 constant IC17y = 9969668930972678457458933488560585559977153665596960984598961849020220006533;
    
    uint256 constant IC18x = 12827315698056961252942871946764432010163554442448812909984595098799600086696;
    uint256 constant IC18y = 18783534052753459797066030093282883211975527992289849232542486467651312022877;
    
    uint256 constant IC19x = 15130067279394479994440857725526580448811123533896805113988393547611417226047;
    uint256 constant IC19y = 1183057252114614708249105175220693939534255208707900496370314288343611002672;
    
 
    // Memory data
    uint16 constant pVk = 0;
    uint16 constant pPairing = 128;

    uint16 constant pLastMem = 896;

    function verifyProof(uint[2] calldata _pA, uint[2][2] calldata _pB, uint[2] calldata _pC, uint[19] calldata _pubSignals) public view returns (bool) {
        assembly {
            function checkField(v) {
                if iszero(lt(v, r)) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }
            
            // G1 function to multiply a G1 value(x,y) to value in an address
            function g1_mulAccC(pR, x, y, s) {
                let success
                let mIn := mload(0x40)
                mstore(mIn, x)
                mstore(add(mIn, 32), y)
                mstore(add(mIn, 64), s)

                success := staticcall(sub(gas(), 2000), 7, mIn, 96, mIn, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }

                mstore(add(mIn, 64), mload(pR))
                mstore(add(mIn, 96), mload(add(pR, 32)))

                success := staticcall(sub(gas(), 2000), 6, mIn, 128, pR, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }

            function checkPairing(pA, pB, pC, pubSignals, pMem) -> isOk {
                let _pPairing := add(pMem, pPairing)
                let _pVk := add(pMem, pVk)

                mstore(_pVk, IC0x)
                mstore(add(_pVk, 32), IC0y)

                // Compute the linear combination vk_x
                
                g1_mulAccC(_pVk, IC1x, IC1y, calldataload(add(pubSignals, 0)))
                
                g1_mulAccC(_pVk, IC2x, IC2y, calldataload(add(pubSignals, 32)))
                
                g1_mulAccC(_pVk, IC3x, IC3y, calldataload(add(pubSignals, 64)))
                
                g1_mulAccC(_pVk, IC4x, IC4y, calldataload(add(pubSignals, 96)))
                
                g1_mulAccC(_pVk, IC5x, IC5y, calldataload(add(pubSignals, 128)))
                
                g1_mulAccC(_pVk, IC6x, IC6y, calldataload(add(pubSignals, 160)))
                
                g1_mulAccC(_pVk, IC7x, IC7y, calldataload(add(pubSignals, 192)))
                
                g1_mulAccC(_pVk, IC8x, IC8y, calldataload(add(pubSignals, 224)))
                
                g1_mulAccC(_pVk, IC9x, IC9y, calldataload(add(pubSignals, 256)))
                
                g1_mulAccC(_pVk, IC10x, IC10y, calldataload(add(pubSignals, 288)))
                
                g1_mulAccC(_pVk, IC11x, IC11y, calldataload(add(pubSignals, 320)))
                
                g1_mulAccC(_pVk, IC12x, IC12y, calldataload(add(pubSignals, 352)))
                
                g1_mulAccC(_pVk, IC13x, IC13y, calldataload(add(pubSignals, 384)))
                
                g1_mulAccC(_pVk, IC14x, IC14y, calldataload(add(pubSignals, 416)))
                
                g1_mulAccC(_pVk, IC15x, IC15y, calldataload(add(pubSignals, 448)))
                
                g1_mulAccC(_pVk, IC16x, IC16y, calldataload(add(pubSignals, 480)))
                
                g1_mulAccC(_pVk, IC17x, IC17y, calldataload(add(pubSignals, 512)))
                
                g1_mulAccC(_pVk, IC18x, IC18y, calldataload(add(pubSignals, 544)))
                
                g1_mulAccC(_pVk, IC19x, IC19y, calldataload(add(pubSignals, 576)))
                

                // -A
                mstore(_pPairing, calldataload(pA))
                mstore(add(_pPairing, 32), mod(sub(q, calldataload(add(pA, 32))), q))

                // B
                mstore(add(_pPairing, 64), calldataload(pB))
                mstore(add(_pPairing, 96), calldataload(add(pB, 32)))
                mstore(add(_pPairing, 128), calldataload(add(pB, 64)))
                mstore(add(_pPairing, 160), calldataload(add(pB, 96)))

                // alpha1
                mstore(add(_pPairing, 192), alphax)
                mstore(add(_pPairing, 224), alphay)

                // beta2
                mstore(add(_pPairing, 256), betax1)
                mstore(add(_pPairing, 288), betax2)
                mstore(add(_pPairing, 320), betay1)
                mstore(add(_pPairing, 352), betay2)

                // vk_x
                mstore(add(_pPairing, 384), mload(add(pMem, pVk)))
                mstore(add(_pPairing, 416), mload(add(pMem, add(pVk, 32))))


                // gamma2
                mstore(add(_pPairing, 448), gammax1)
                mstore(add(_pPairing, 480), gammax2)
                mstore(add(_pPairing, 512), gammay1)
                mstore(add(_pPairing, 544), gammay2)

                // C
                mstore(add(_pPairing, 576), calldataload(pC))
                mstore(add(_pPairing, 608), calldataload(add(pC, 32)))

                // delta2
                mstore(add(_pPairing, 640), deltax1)
                mstore(add(_pPairing, 672), deltax2)
                mstore(add(_pPairing, 704), deltay1)
                mstore(add(_pPairing, 736), deltay2)


                let success := staticcall(sub(gas(), 2000), 8, _pPairing, 768, _pPairing, 0x20)

                isOk := and(success, mload(_pPairing))
            }

            let pMem := mload(0x40)
            mstore(0x40, add(pMem, pLastMem))

            // Validate that all evaluations ∈ F
            
            checkField(calldataload(add(_pubSignals, 0)))
            
            checkField(calldataload(add(_pubSignals, 32)))
            
            checkField(calldataload(add(_pubSignals, 64)))
            
            checkField(calldataload(add(_pubSignals, 96)))
            
            checkField(calldataload(add(_pubSignals, 128)))
            
            checkField(calldataload(add(_pubSignals, 160)))
            
            checkField(calldataload(add(_pubSignals, 192)))
            
            checkField(calldataload(add(_pubSignals, 224)))
            
            checkField(calldataload(add(_pubSignals, 256)))
            
            checkField(calldataload(add(_pubSignals, 288)))
            
            checkField(calldataload(add(_pubSignals, 320)))
            
            checkField(calldataload(add(_pubSignals, 352)))
            
            checkField(calldataload(add(_pubSignals, 384)))
            
            checkField(calldataload(add(_pubSignals, 416)))
            
            checkField(calldataload(add(_pubSignals, 448)))
            
            checkField(calldataload(add(_pubSignals, 480)))
            
            checkField(calldataload(add(_pubSignals, 512)))
            
            checkField(calldataload(add(_pubSignals, 544)))
            
            checkField(calldataload(add(_pubSignals, 576)))
            

            // Validate all evaluations
            let isValid := checkPairing(_pA, _pB, _pC, _pubSignals, pMem)

            mstore(0, isValid)
             return(0, 0x20)
         }
     }
 }
